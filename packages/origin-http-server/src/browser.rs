use std::future::Future;
use std::io::SeekFrom;
use std::time::Duration;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header::CACHE_CONTROL, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::{Extension, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{interval, timeout, MissedTickBehavior};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as TungMessage;
use tracing::warn;

use crate::auth::OriginClaims;
use crate::error::OriginError;
use crate::routes::AppState;

#[derive(Debug, Deserialize)]
struct BrowserTargetPathParams {
    page_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPagesQuery {
    #[serde(default)]
    include_placeholder: bool,
}

#[derive(Debug, Deserialize)]
struct BrowserCdpTargetDescriptor {
    id: String,
    #[serde(rename = "type")]
    target_type: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(rename = "webSocketDebuggerUrl", default)]
    websocket_debugger_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageResponse {
    id: String,
    url: String,
    host: String,
    label: String,
    title: Option<String>,
    is_active: bool,
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPagesResponse {
    pages: Vec<BrowserPageResponse>,
    active_page_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCapabilitiesResponse {
    version: u8,
    approval_modes: [&'static str; 2],
    viewer_kinds: Vec<&'static str>,
    preferred_viewer: &'static str,
    viewport_only: bool,
    rfb: BrowserRfbCapabilitiesResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    webrtc: Option<crate::browser_webrtc::BrowserWebRtcCapabilities>,
    controls: BrowserControlsResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserRfbCapabilitiesResponse {
    /// Fixed Chromium/X11 device scale for this runtime. The viewer must use
    /// the same multiplier when it requests an RFB desktop resize so page CSS
    /// geometry and input coordinates remain aligned.
    render_scale: f64,
    /// Hard ceiling for a remotely requested framebuffer. The client preserves
    /// aspect ratio when it needs to fit a larger local surface under this cap.
    max_framebuffer_pixels: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserControlsResponse {
    navigate: bool,
    history: bool,
    reload: bool,
    focus_page: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum BrowserPageCommandAction {
    Navigate,
    Back,
    Forward,
    Reload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserPageCommandRequest {
    action: BrowserPageCommandAction,
    url: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct BrowserNavigationState {
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct BrowserNavigationHistory {
    current_index: usize,
    entry_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
struct BrowserActionsQuery {
    /// Byte offset returned as `cursor` from the previous poll. The actions log
    /// is append-only, so the offset is a naturally monotonic, cross-process
    /// tail cursor.
    since: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserActionResponse {
    seq: u64,
    ts: i64,
    /// Exact CDP target that produced the action. Older logs may be unscoped;
    /// viewers must not attribute those events to their selected page.
    page_id: Option<String>,
    #[serde(rename = "type")]
    action_type: String,
    label: String,
    url: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    viewport_w: Option<f64>,
    viewport_h: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    human_input_request: Option<BrowserHumanInputRequest>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserHumanInputRequest {
    version: u8,
    handoff_id: String,
    run_id: String,
    initiator_user_id: String,
    browser_page_id: String,
    origin: String,
    created_at_ms: u64,
    expires_at_ms: u64,
    fields: Vec<BrowserHumanInputField>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BrowserHumanInputField {
    label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserActionsResponse {
    actions: Vec<BrowserActionResponse>,
    cursor: u64,
}

/// Cap the events returned in one poll so a long session can't return a huge
/// backlog; the UI only ever shows the most recent handful.
const BROWSER_ACTIONS_MAX_RETURNED: usize = 200;
const BROWSER_ACTIONS_READ_WINDOW_BYTES: usize = 256 * 1024;
const BROWSER_ACTION_LABEL_MAX_BYTES: usize = 1024;
const BROWSER_ACTION_URL_MAX_BYTES: usize = 16 * 1024;
const BROWSER_ACTION_PAGE_ID_MAX_BYTES: usize = 256;
/// Browser CDP lives on loopback, so a command taking longer than this is a
/// broken browser/session. Keep every websocket operation bounded instead of
/// tying up an origin request indefinitely.
const BROWSER_CDP_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const BROWSER_CDP_LIST_BODY_MAX_BYTES: usize = 1024 * 1024;
const BROWSER_CDP_ACTIVATE_BODY_MAX_BYTES: usize = 64 * 1024;
const BROWSER_CDP_ERROR_PREVIEW_MAX_BYTES: usize = 2048;
const BROWSER_CDP_TARGET_MAX_COUNT: usize = 128;
const BROWSER_CDP_TARGET_TITLE_MAX_BYTES: usize = 1024;
const BROWSER_CDP_TARGET_URL_MAX_BYTES: usize = 32 * 1024;
const BROWSER_NAVIGATION_URL_MAX_BYTES: usize = 8 * 1024;
const BROWSER_PAGE_COMMAND_BODY_LIMIT_BYTES: usize = 12 * 1024;
const BROWSER_APPROVAL_DECISION_BODY_LIMIT_BYTES: usize = 4 * 1024;
const BROWSER_WEBRTC_OFFER_BODY_LIMIT_BYTES: usize = 256 * 1024;
const DEFAULT_BROWSER_RFB_RENDER_SCALE: f64 = 1.0;
const MAX_BROWSER_RFB_RENDER_SCALE: f64 = 2.0;
const DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS: u64 = 8_294_400; // 3840 × 2160
const MIN_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS: u64 = 921_600; // 1280 × 720
const MAX_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS: u64 = 16_777_216; // 4096 × 4096

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BrowserActionsReadPlan {
    start: u64,
    length: usize,
    discard_initial_partial_line: bool,
}

/// Metadata and observation-only browser endpoints. These never send input to
/// Chromium and are safe to expose to a `browser.view` grant.
pub fn view_routes() -> Router<AppState> {
    Router::new()
        .route("/browser/capabilities", get(handle_browser_capabilities))
        .route("/browser/pages", get(handle_browser_pages))
        .route("/browser/actions", get(handle_browser_actions))
        .route(
            "/browser/approval/pending",
            get(crate::browser_approval::handle_pending_approval),
        )
        .route(
            "/browser/collaboration",
            get(crate::browser_collaboration::handle_collaboration_ws),
        )
        .route(
            "/browser/screencast",
            get(crate::browser_screencast::handle_browser_screencast_ws),
        )
        .route(
            "/browser/webrtc/offer",
            post(crate::browser_webrtc::handle_offer)
                .layer(DefaultBodyLimit::max(BROWSER_WEBRTC_OFFER_BODY_LIMIT_BYTES)),
        )
}

/// Browser endpoints that mutate the active page or inject input. They require
/// `browser.control`, independently of workspace write access.
pub fn control_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/browser/input",
            get(crate::browser_screencast::handle_browser_input_ws),
        )
        .route(
            "/browser/pages/:page_id/focus",
            post(handle_focus_browser_page),
        )
        .route(
            "/browser/pages/:page_id/command",
            post(handle_browser_page_command)
                .layer(DefaultBodyLimit::max(BROWSER_PAGE_COMMAND_BODY_LIMIT_BYTES)),
        )
        .route(
            "/browser/approval/decision",
            post(crate::browser_approval::handle_approval_decision).layer(DefaultBodyLimit::max(
                BROWSER_APPROVAL_DECISION_BODY_LIMIT_BYTES,
            )),
        )
}

/// RFB multiplexes pixels and raw input without a message boundary the origin
/// can safely filter. Keep it driver-exclusive. CDP screencast and WebRTC are
/// observation routes; their bounded input is separately lease-gated.
pub fn interactive_transport_routes() -> Router<AppState> {
    Router::new().route("/browser/vnc", get(handle_vnc_ws))
}

fn browser_actions_file_path() -> String {
    std::env::var("INSTAFY_BROWSER_ACTIONS_FILE")
        .unwrap_or_else(|_| "/tmp/instafy/playwright/actions.jsonl".to_string())
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn parse_browser_action_line(line: &str) -> Option<BrowserActionResponse> {
    let value = serde_json::from_str::<JsonValue>(line.trim()).ok()?;
    let action_type = value.get("type").and_then(JsonValue::as_str)?.to_string();
    if action_type.is_empty() {
        return None;
    }
    // Reject invalid IDs instead of truncating/normalizing them into the
    // identity of a different target. Unscoped legacy events remain readable.
    let page_id = value
        .get("pageId")
        .and_then(JsonValue::as_str)
        .filter(|id| valid_browser_action_page_id(id))
        .map(str::to_string);
    let human_input_request = if action_type == "human_input" {
        let request = serde_json::from_value::<BrowserHumanInputRequest>(
            value.get("humanInputRequest")?.clone(),
        )
        .ok()?;
        if !valid_browser_human_input_request(&request)
            || page_id.as_deref() != Some(request.browser_page_id.as_str())
        {
            return None;
        }
        Some(request)
    } else {
        None
    };
    Some(BrowserActionResponse {
        seq: value.get("seq").and_then(JsonValue::as_u64).unwrap_or(0),
        ts: value.get("ts").and_then(JsonValue::as_i64).unwrap_or(0),
        page_id,
        action_type,
        label: value
            .get("label")
            .and_then(JsonValue::as_str)
            .map(|label| truncate_utf8_bytes(label, BROWSER_ACTION_LABEL_MAX_BYTES))
            .unwrap_or_default(),
        url: value
            .get("url")
            .and_then(JsonValue::as_str)
            .map(|url| truncate_utf8_bytes(url, BROWSER_ACTION_URL_MAX_BYTES)),
        x: value.get("x").and_then(JsonValue::as_f64),
        y: value.get("y").and_then(JsonValue::as_f64),
        viewport_w: value.get("viewportW").and_then(JsonValue::as_f64),
        viewport_h: value.get("viewportH").and_then(JsonValue::as_f64),
        human_input_request,
    })
}

fn valid_browser_action_page_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= BROWSER_ACTION_PAGE_ID_MAX_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_browser_human_input_request(request: &BrowserHumanInputRequest) -> bool {
    let canonical_uuid = |value: &str| {
        uuid::Uuid::parse_str(value)
            .map(|id| id.to_string() == value)
            .unwrap_or(false)
    };
    let valid_origin = reqwest::Url::parse(&request.origin)
        .map(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
                && url.origin().ascii_serialization() == request.origin
        })
        .unwrap_or(false);
    request.version == 1
        && canonical_uuid(&request.handoff_id)
        && canonical_uuid(&request.run_id)
        && canonical_uuid(&request.initiator_user_id)
        && valid_browser_action_page_id(&request.browser_page_id)
        && request.origin.len() <= 512
        && valid_origin
        && request.created_at_ms > 0
        && request.expires_at_ms <= 9_007_199_254_740_991
        && request.expires_at_ms > request.created_at_ms
        && request.expires_at_ms - request.created_at_ms <= 600_000
        && !request.fields.is_empty()
        && request.fields.len() <= 8
        && request.fields.iter().all(|field| {
            !field.label.trim().is_empty()
                && field.label.len() <= 80
                && !field.label.chars().any(char::is_control)
        })
}

fn browser_actions_read_plan(file_len: u64, since: u64) -> BrowserActionsReadPlan {
    // `since` past the end means the log was truncated/rotated (new session) —
    // reset to the start so the client re-syncs instead of missing everything.
    let logical_start = if since > file_len { 0 } else { since };
    let bounded_floor = file_len.saturating_sub(BROWSER_ACTIONS_READ_WINDOW_BYTES as u64);
    let start = logical_start.max(bounded_floor);
    BrowserActionsReadPlan {
        start,
        length: file_len
            .saturating_sub(start)
            .min(BROWSER_ACTIONS_READ_WINDOW_BYTES as u64) as usize,
        discard_initial_partial_line: start > logical_start,
    }
}

fn tail_browser_actions(
    bytes: &[u8],
    absolute_start: u64,
    discard_initial_partial_line: bool,
) -> BrowserActionsResponse {
    let (discarded, slice) = if discard_initial_partial_line {
        match bytes.iter().position(|&byte| byte == b'\n') {
            Some(index) => (index + 1, &bytes[index + 1..]),
            None => {
                return BrowserActionsResponse {
                    actions: Vec::new(),
                    cursor: absolute_start,
                };
            }
        }
    } else {
        (0, bytes)
    };
    // Only consume through the last newline. A trailing line with no newline is a
    // torn read while the agent is mid-append; leaving it (and not advancing the
    // cursor past it) means it is retried on the next poll instead of being
    // permanently skipped. Newlines are ASCII, so this is always a valid UTF-8
    // boundary regardless of where `start` fell.
    let consumed = match slice.iter().rposition(|&byte| byte == b'\n') {
        Some(index) => index + 1,
        None => 0,
    };
    let text = String::from_utf8_lossy(&slice[..consumed]);
    let mut actions: Vec<BrowserActionResponse> =
        text.lines().filter_map(parse_browser_action_line).collect();
    if actions.len() > BROWSER_ACTIONS_MAX_RETURNED {
        actions.drain(0..actions.len() - BROWSER_ACTIONS_MAX_RETURNED);
    }
    BrowserActionsResponse {
        actions,
        cursor: absolute_start + discarded as u64 + consumed as u64,
    }
}

async fn read_browser_actions(path: &str, since: u64) -> std::io::Result<BrowserActionsResponse> {
    let mut file = tokio::fs::File::open(path).await?;
    let file_len = file.metadata().await?.len();
    let plan = browser_actions_read_plan(file_len, since);
    if plan.start > 0 {
        file.seek(SeekFrom::Start(plan.start)).await?;
    }
    let mut bytes = Vec::with_capacity(plan.length);
    file.take(plan.length as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(tail_browser_actions(
        &bytes,
        plan.start,
        plan.discard_initial_partial_line,
    ))
}

fn normalize_vnc_host(raw: Option<String>) -> String {
    let host = raw
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let lowered = host.to_ascii_lowercase();
    if lowered == "host.docker.internal"
        || lowered == "0.0.0.0"
        || lowered == "::"
        || lowered == "[::]"
    {
        // Browser sessions run in the same runtime container as origin-http-server.
        // Treat host-gateway / wildcard host values as a misconfiguration and force loopback.
        return "127.0.0.1".to_string();
    }
    host
}

fn resolve_vnc_target() -> (String, u16) {
    let host = normalize_vnc_host(std::env::var("INSTAFY_VNC_HOST").ok());
    let port = std::env::var("INSTAFY_VNC_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(5900);
    (host, port)
}

async fn handle_vnc_ws(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    ws: WebSocketUpgrade,
) -> Result<Response, OriginError> {
    state
        .browser_collaboration
        .assert_human_control(&claims)
        .await?;
    let pixel_admission = state.browser_collaboration.admit_pixel_stream(&claims)?;
    let (host, port) = resolve_vnc_target();
    Ok(ws.on_upgrade(move |socket| {
        bridge_vnc_ws(socket, host, port, state, claims, pixel_admission)
    }))
}

fn resolve_browser_cdp_base_url() -> String {
    let port = std::env::var("INSTAFY_PLAYWRIGHT_CDP_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(9223);
    format!("http://127.0.0.1:{port}")
}

async fn read_bounded_http_body(
    mut response: reqwest::Response,
    max_bytes: usize,
    context: &str,
) -> Result<Vec<u8>, OriginError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(OriginError::unavailable(format!(
            "{context} response exceeds {max_bytes} bytes"
        )));
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        OriginError::unavailable(format!("failed to read {context} response: {error}"))
    })? {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(OriginError::unavailable(format!(
                "{context} response exceeds {max_bytes} bytes"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn bounded_error_preview(body: &[u8]) -> String {
    let preview_len = body.len().min(BROWSER_CDP_ERROR_PREVIEW_MAX_BYTES);
    let preview = String::from_utf8_lossy(&body[..preview_len]);
    if body.len() > preview_len {
        format!("{preview}…")
    } else {
        preview.into_owned()
    }
}

fn browser_capabilities(
    viewport_only: bool,
    cdp_screencast_enabled: bool,
    webrtc: Option<crate::browser_webrtc::BrowserWebRtcCapabilities>,
    requested_preferred_viewer: Option<&str>,
) -> BrowserCapabilitiesResponse {
    let mut viewer_kinds = Vec::with_capacity(3);
    if webrtc.is_some() {
        viewer_kinds.push("webrtc");
    }
    if cdp_screencast_enabled {
        viewer_kinds.push("cdp-screencast");
    }
    viewer_kinds.push("rfb");
    let preferred_viewer = requested_preferred_viewer
        .map(|value| value.trim().to_ascii_lowercase())
        .and_then(|value| match value.as_str() {
            "webrtc" if viewer_kinds.contains(&"webrtc") => Some("webrtc"),
            "cdp-screencast" if viewer_kinds.contains(&"cdp-screencast") => Some("cdp-screencast"),
            "rfb" => Some("rfb"),
            _ => None,
        })
        .unwrap_or(viewer_kinds[0]);
    BrowserCapabilitiesResponse {
        version: 2,
        approval_modes: ["ask", "routine"],
        viewer_kinds,
        preferred_viewer,
        viewport_only,
        rfb: BrowserRfbCapabilitiesResponse {
            render_scale: browser_rfb_render_scale(),
            max_framebuffer_pixels: browser_rfb_max_framebuffer_pixels(),
        },
        webrtc,
        controls: BrowserControlsResponse {
            navigate: true,
            history: true,
            reload: true,
            focus_page: true,
        },
    }
}

fn browser_rfb_render_scale() -> f64 {
    std::env::var("INSTAFY_BROWSER_RENDER_SCALE")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| {
            value.clamp(
                DEFAULT_BROWSER_RFB_RENDER_SCALE,
                MAX_BROWSER_RFB_RENDER_SCALE,
            )
        })
        .unwrap_or(DEFAULT_BROWSER_RFB_RENDER_SCALE)
}

fn browser_rfb_max_framebuffer_pixels() -> u64 {
    std::env::var("INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| {
            value.clamp(
                MIN_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS,
                MAX_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS,
            )
        })
        .unwrap_or(DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS)
}

async fn handle_browser_capabilities(headers: HeaderMap) -> Response {
    let requested_preferred_viewer = std::env::var("INSTAFY_BROWSER_PREFERRED_VIEWER").ok();
    (
        [(CACHE_CONTROL, "no-store")],
        Json(browser_capabilities(
            std::env::var("INSTAFY_BROWSER_VIEWPORT_ONLY")
                .ok()
                .as_deref()
                == Some("1"),
            crate::browser_screencast::browser_screencast_enabled(),
            crate::browser_webrtc::capabilities_for_headers(&headers),
            requested_preferred_viewer.as_deref(),
        )),
    )
        .into_response()
}

fn normalize_browser_page_title(raw: &str) -> Option<String> {
    let normalized = raw.trim().replace('\n', " ");
    let collapsed = normalized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_matches('.')
        .to_string();
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed)
}

fn normalize_browser_page_host(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed
                .host_str()
                .map(|value| value.trim().to_ascii_lowercase())
        })
        .map(|host| host.trim_start_matches("www.").to_string())
        .unwrap_or_default()
}

fn derive_browser_page_label(title: Option<&str>, host: &str, url: &str) -> String {
    let trimmed_title = title.unwrap_or("").trim();
    if !trimmed_title.is_empty() {
        for separator in [" | ", " — ", " – ", " - ", " · "] {
            if let Some((prefix, _)) = trimmed_title.split_once(separator) {
                let candidate = prefix.trim();
                if (3..=48).contains(&candidate.len()) {
                    return candidate.to_string();
                }
            }
        }
        if let Some((prefix, _)) = trimmed_title.split_once(',') {
            let candidate = prefix.trim();
            if (3..=40).contains(&candidate.len()) {
                return candidate.to_string();
            }
        }
        return trimmed_title.to_string();
    }

    if !host.is_empty() {
        return host.to_string();
    }

    let normalized_url = url.trim();
    if normalized_url.eq_ignore_ascii_case("about:blank") {
        return "New tab".to_string();
    }
    if normalized_url.is_empty() {
        return "Browser page".to_string();
    }
    normalized_url.to_string()
}

fn browser_target_is_placeholder(target: &BrowserCdpTargetDescriptor) -> bool {
    let normalized_url = target.url.trim().to_ascii_lowercase();
    if normalized_url.is_empty() || normalized_url == "about:blank" {
        return true;
    }
    matches!(
        normalized_url.as_str(),
        "chrome://newtab/" | "chrome://new-tab-page/" | "edge://newtab/"
    )
}

fn filter_browser_page_targets(
    mut targets: Vec<BrowserCdpTargetDescriptor>,
    include_placeholder: bool,
) -> Vec<BrowserCdpTargetDescriptor> {
    if include_placeholder {
        return targets;
    }

    let has_real_page = targets
        .iter()
        .any(|target| !browser_target_is_placeholder(target));
    if has_real_page {
        targets.retain(|target| !browser_target_is_placeholder(target));
        targets
    } else {
        Vec::new()
    }
}

fn normalize_browser_cdp_targets(
    targets: Vec<BrowserCdpTargetDescriptor>,
) -> Vec<BrowserCdpTargetDescriptor> {
    targets
        .into_iter()
        .filter(|target| target.target_type == "page")
        .take(BROWSER_CDP_TARGET_MAX_COUNT)
        .map(|mut target| {
            target.title = truncate_utf8_bytes(&target.title, BROWSER_CDP_TARGET_TITLE_MAX_BYTES);
            target.url = truncate_utf8_bytes(&target.url, BROWSER_CDP_TARGET_URL_MAX_BYTES);
            target
        })
        .collect()
}

async fn fetch_browser_cdp_targets(
    state: &AppState,
) -> Result<Vec<BrowserCdpTargetDescriptor>, OriginError> {
    let url = format!("{}/json/list", resolve_browser_cdp_base_url());
    timeout(BROWSER_CDP_COMMAND_TIMEOUT, async {
        let response = state.http_client.get(url).send().await.map_err(|error| {
            OriginError::unavailable(format!("browser cdp unavailable: {error}"))
        })?;
        let status = response.status();
        let body = read_bounded_http_body(
            response,
            BROWSER_CDP_LIST_BODY_MAX_BYTES,
            "browser cdp list",
        )
        .await?;
        if !status.is_success() {
            return Err(OriginError::unavailable(format!(
                "browser cdp list unavailable ({status}): {}",
                bounded_error_preview(&body)
            )));
        }

        let targets =
            serde_json::from_slice::<Vec<BrowserCdpTargetDescriptor>>(&body).map_err(|error| {
                OriginError::unavailable(format!("invalid browser cdp list: {error}"))
            })?;
        Ok(normalize_browser_cdp_targets(targets))
    })
    .await
    .map_err(|_| OriginError::unavailable("browser cdp list timed out"))?
}

async fn send_browser_cdp_command(
    websocket_url: &str,
    method: &'static str,
    params: JsonValue,
) -> Result<JsonValue, OriginError> {
    timeout(BROWSER_CDP_COMMAND_TIMEOUT, async {
        let (mut socket, _response) = connect_async(websocket_url).await.map_err(|error| {
            OriginError::unavailable(format!("browser cdp connection failed: {error}"))
        })?;
        let command = serde_json::json!({
            "id": 1,
            "method": method,
            "params": params,
        });

        socket
            .send(TungMessage::Text(command.to_string()))
            .await
            .map_err(|error| {
                OriginError::unavailable(format!("browser cdp command failed: {error}"))
            })?;

        while let Some(message) = socket.next().await {
            let message = message.map_err(|error| {
                OriginError::unavailable(format!("browser cdp response failed: {error}"))
            })?;
            let payload = match message {
                TungMessage::Text(text) => serde_json::from_str::<JsonValue>(&text).ok(),
                TungMessage::Binary(bytes) => serde_json::from_slice::<JsonValue>(&bytes).ok(),
                TungMessage::Ping(payload) => {
                    socket
                        .send(TungMessage::Pong(payload))
                        .await
                        .map_err(|error| {
                            OriginError::unavailable(format!("browser cdp pong failed: {error}"))
                        })?;
                    None
                }
                TungMessage::Close(_) => break,
                _ => None,
            };
            let Some(payload) = payload else {
                continue;
            };
            if payload.get("id").and_then(JsonValue::as_i64) != Some(1) {
                continue;
            }
            if let Some(error) = payload.get("error") {
                let message = error
                    .get("message")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("unknown CDP error");
                return Err(OriginError::unavailable(format!(
                    "browser cdp rejected {method}: {message}"
                )));
            }
            return Ok(payload.get("result").cloned().unwrap_or(JsonValue::Null));
        }

        Err(OriginError::unavailable(
            "browser cdp closed before responding",
        ))
    })
    .await
    .map_err(|_| OriginError::unavailable("browser cdp command timed out"))?
}

async fn browser_target_has_focus(websocket_url: &str) -> Option<bool> {
    send_browser_cdp_command(
        websocket_url,
        "Runtime.evaluate",
        serde_json::json!({
            "expression": "document.hasFocus()",
            "returnByValue": true,
            "awaitPromise": false,
            "userGesture": false
        }),
    )
    .await
    .ok()?
    .get("result")
    .and_then(|result| result.get("value"))
    .and_then(JsonValue::as_bool)
}

async fn resolve_browser_active_page_id(targets: &[BrowserCdpTargetDescriptor]) -> Option<String> {
    // A user-controlled tab count must not multiply the per-command timeout
    // into an unbounded pages poll. Bound the entire focus scan as well.
    timeout(BROWSER_CDP_COMMAND_TIMEOUT, async {
        for target in targets {
            let websocket_url = target
                .websocket_debugger_url
                .as_deref()
                .unwrap_or("")
                .trim();
            if websocket_url.is_empty() {
                continue;
            }
            if browser_target_has_focus(websocket_url).await == Some(true) {
                return Some(target.id.clone());
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

fn parse_browser_navigation_history(result: &JsonValue) -> Option<BrowserNavigationHistory> {
    let current_index = result.get("currentIndex")?.as_i64()?;
    let current_index = usize::try_from(current_index).ok()?;
    let entry_ids = result
        .get("entries")?
        .as_array()?
        .iter()
        .map(|entry| entry.get("id").and_then(JsonValue::as_i64))
        .collect::<Option<Vec<_>>>()?;
    if entry_ids.is_empty() || current_index >= entry_ids.len() {
        return None;
    }
    Some(BrowserNavigationHistory {
        current_index,
        entry_ids,
    })
}

fn browser_navigation_state(history: &BrowserNavigationHistory) -> BrowserNavigationState {
    BrowserNavigationState {
        can_go_back: history.current_index > 0,
        can_go_forward: history.current_index + 1 < history.entry_ids.len(),
    }
}

async fn fetch_browser_navigation_history(
    websocket_url: &str,
) -> Result<BrowserNavigationHistory, OriginError> {
    let result = send_browser_cdp_command(
        websocket_url,
        "Page.getNavigationHistory",
        serde_json::json!({}),
    )
    .await?;
    parse_browser_navigation_history(&result)
        .ok_or_else(|| OriginError::unavailable("invalid browser navigation history response"))
}

fn normalize_browser_navigation_url(raw: &str) -> Result<String, OriginError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(OriginError::bad_request("navigation url is required"));
    }
    if trimmed.len() > BROWSER_NAVIGATION_URL_MAX_BYTES {
        return Err(OriginError::bad_request("navigation url is too long"));
    }
    if trimmed.eq_ignore_ascii_case("about:blank") {
        return Ok("about:blank".to_string());
    }

    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| OriginError::bad_request("navigation url is invalid"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(OriginError::bad_request(
            "navigation url must use http or https",
        ));
    }
    if parsed.host_str().is_none() {
        return Err(OriginError::bad_request(
            "navigation url must include a host",
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(OriginError::bad_request(
            "navigation url must not include credentials",
        ));
    }
    Ok(parsed.to_string())
}

fn validate_browser_page_command(
    command: &BrowserPageCommandRequest,
) -> Result<Option<String>, OriginError> {
    match command.action {
        BrowserPageCommandAction::Navigate => command
            .url
            .as_deref()
            .ok_or_else(|| OriginError::bad_request("navigation url is required"))
            .and_then(normalize_browser_navigation_url)
            .map(Some),
        BrowserPageCommandAction::Back
        | BrowserPageCommandAction::Forward
        | BrowserPageCommandAction::Reload => {
            if command.url.is_some() {
                return Err(OriginError::bad_request(
                    "url is only allowed for navigate commands",
                ));
            }
            Ok(None)
        }
    }
}

async fn handle_browser_pages(
    State(state): State<AppState>,
    Query(query): Query<BrowserPagesQuery>,
) -> Result<Json<BrowserPagesResponse>, OriginError> {
    let targets = filter_browser_page_targets(
        fetch_browser_cdp_targets(&state).await?,
        query.include_placeholder,
    );

    let active_page_id = resolve_browser_active_page_id(&targets).await;
    let history_target_id = if targets.len() == 1 {
        targets.first().map(|target| target.id.clone())
    } else {
        active_page_id.clone()
    };
    // History is only needed for the page the toolbar controls. Avoid exposing
    // history entries and avoid opening a CDP socket for every background tab.
    let history_state = if let Some(target) = history_target_id.as_deref().and_then(|id| {
        targets
            .iter()
            .find(|target| target.id == id)
            .and_then(|target| target.websocket_debugger_url.as_deref())
    }) {
        fetch_browser_navigation_history(target)
            .await
            .ok()
            .map(|history| browser_navigation_state(&history))
            .unwrap_or_default()
    } else {
        BrowserNavigationState::default()
    };
    let pages = targets
        .into_iter()
        .map(|target| {
            let title = normalize_browser_page_title(&target.title);
            let host = normalize_browser_page_host(&target.url);
            let has_history_state = history_target_id.as_deref() == Some(target.id.as_str());
            BrowserPageResponse {
                id: target.id.clone(),
                url: target.url.trim().to_string(),
                host: host.clone(),
                label: derive_browser_page_label(title.as_deref(), &host, &target.url),
                title,
                is_active: active_page_id.as_deref() == Some(target.id.as_str()),
                can_go_back: has_history_state && history_state.can_go_back,
                can_go_forward: has_history_state && history_state.can_go_forward,
            }
        })
        .collect();

    Ok(Json(BrowserPagesResponse {
        pages,
        active_page_id,
    }))
}

async fn handle_browser_actions(
    State(_state): State<AppState>,
    Query(query): Query<BrowserActionsQuery>,
) -> Result<Json<BrowserActionsResponse>, OriginError> {
    // Like /browser/pages, the source is a fixed container-local OS resource
    // (the agent's append-only actions log), not the per-project git workspace,
    // so no project/workspace/apply-lock plumbing is needed.
    let path = browser_actions_file_path();
    let since = query.since.unwrap_or(0);
    let response = match read_browser_actions(&path, since).await {
        Ok(response) => response,
        // No session/log yet — return an empty tail rather than an error.
        Err(_) => {
            return Ok(Json(BrowserActionsResponse {
                actions: Vec::new(),
                cursor: 0,
            }));
        }
    };
    Ok(Json(response))
}

async fn handle_focus_browser_page(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Path(params): Path<BrowserTargetPathParams>,
) -> Result<StatusCode, OriginError> {
    state
        .browser_collaboration
        .assert_human_control(&claims)
        .await?;
    let page_id = params.page_id.trim();
    if page_id.is_empty() {
        return Err(OriginError::bad_request("page id is required"));
    }

    let targets = fetch_browser_cdp_targets(&state).await?;
    if !targets.iter().any(|target| target.id == page_id) {
        return Err(OriginError::not_found("browser page not found"));
    }

    let url = format!(
        "{}/json/activate/{}",
        resolve_browser_cdp_base_url(),
        page_id
    );
    // Target discovery is asynchronous. Re-check the live owner immediately
    // before the activating request so a handoff during discovery cannot use
    // the old participant's authority.
    state
        .browser_collaboration
        .assert_human_control(&claims)
        .await?;
    timeout(BROWSER_CDP_COMMAND_TIMEOUT, async {
        let response = state.http_client.get(url).send().await.map_err(|error| {
            OriginError::unavailable(format!("failed to focus browser page: {error}"))
        })?;
        let status = response.status();
        let body = read_bounded_http_body(
            response,
            BROWSER_CDP_ACTIVATE_BODY_MAX_BYTES,
            "browser page focus",
        )
        .await?;
        if !status.is_success() {
            return Err(OriginError::unavailable(format!(
                "browser page focus unavailable ({status}): {}",
                bounded_error_preview(&body)
            )));
        }
        Ok(())
    })
    .await
    .map_err(|_| OriginError::unavailable("browser page focus timed out"))??;

    Ok(StatusCode::NO_CONTENT)
}

fn browser_history_destination(
    history: &BrowserNavigationHistory,
    action: BrowserPageCommandAction,
) -> Option<i64> {
    let index = match action {
        BrowserPageCommandAction::Back => history.current_index.checked_sub(1)?,
        BrowserPageCommandAction::Forward => history.current_index.checked_add(1)?,
        _ => return None,
    };
    history.entry_ids.get(index).copied()
}

async fn handle_browser_page_command(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Path(params): Path<BrowserTargetPathParams>,
    Json(command): Json<BrowserPageCommandRequest>,
) -> Result<StatusCode, OriginError> {
    state
        .browser_collaboration
        .assert_human_control(&claims)
        .await?;
    let page_id = params.page_id.trim();
    if page_id.is_empty() {
        return Err(OriginError::bad_request("page id is required"));
    }
    let normalized_url = validate_browser_page_command(&command)?;

    let targets = fetch_browser_cdp_targets(&state).await?;
    let target = targets
        .iter()
        .find(|target| target.id == page_id)
        .ok_or_else(|| OriginError::not_found("browser page not found"))?;
    let websocket_url = target
        .websocket_debugger_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| OriginError::unavailable("browser page CDP endpoint is unavailable"))?;

    match command.action {
        BrowserPageCommandAction::Navigate => {
            let url = normalized_url
                .ok_or_else(|| OriginError::bad_request("navigation url is required"))?;
            state
                .browser_collaboration
                .assert_human_control(&claims)
                .await?;
            let result = send_browser_cdp_command(
                websocket_url,
                "Page.navigate",
                serde_json::json!({ "url": url }),
            )
            .await?;
            if let Some(error_text) = result
                .get("errorText")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Err(OriginError::unavailable(format!(
                    "browser navigation failed: {error_text}"
                )));
            }
        }
        BrowserPageCommandAction::Back | BrowserPageCommandAction::Forward => {
            let history = fetch_browser_navigation_history(websocket_url).await?;
            let boundary_error = match command.action {
                BrowserPageCommandAction::Back => "browser page cannot go back",
                BrowserPageCommandAction::Forward => "browser page cannot go forward",
                _ => "browser page history command is invalid",
            };
            let entry_id = browser_history_destination(&history, command.action)
                .ok_or_else(|| OriginError::conflict(boundary_error))?;
            state
                .browser_collaboration
                .assert_human_control(&claims)
                .await?;
            send_browser_cdp_command(
                websocket_url,
                "Page.navigateToHistoryEntry",
                serde_json::json!({ "entryId": entry_id }),
            )
            .await?;
        }
        BrowserPageCommandAction::Reload => {
            state
                .browser_collaboration
                .assert_human_control(&claims)
                .await?;
            send_browser_cdp_command(
                websocket_url,
                "Page.reload",
                serde_json::json!({ "ignoreCache": false }),
            )
            .await?;
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn bridge_vnc_ws(
    socket: WebSocket,
    host: String,
    port: u16,
    state: AppState,
    claims: OriginClaims,
    _pixel_admission: crate::browser_collaboration::PixelStreamAdmission,
) {
    let tcp = match TcpStream::connect((host.as_str(), port)).await {
        Ok(stream) => stream,
        Err(primary_error) => {
            // Fall back to loopback when INSTAFY_VNC_HOST is misconfigured.
            if host != "127.0.0.1" {
                match TcpStream::connect(("127.0.0.1", port)).await {
                    Ok(stream) => {
                        warn!(
                            ?primary_error,
                            original_host = %host,
                            fallback_host = "127.0.0.1",
                            port = port,
                            "failed to connect to configured VNC host; using loopback fallback"
                        );
                        stream
                    }
                    Err(fallback_error) => {
                        warn!(
                            ?primary_error,
                            ?fallback_error,
                            original_host = %host,
                            fallback_host = "127.0.0.1",
                            port = port,
                            "failed to connect to VNC target"
                        );
                        let _ = socket.close().await;
                        return;
                    }
                }
            } else {
                warn!(
                    ?primary_error,
                    host = %host,
                    port = port,
                    "failed to connect to VNC target"
                );
                let _ = socket.close().await;
                return;
            }
        }
    };

    if let Err(error) = tcp.set_nodelay(true) {
        warn!(?error, "failed to set TCP_NODELAY for VNC connection");
    }

    let (mut socket_sender, mut socket_receiver) = socket.split();
    let (mut tcp_reader, mut tcp_writer) = tcp.into_split();
    let mut tcp_buf = vec![0u8; 32 * 1024];
    let mut control_check = interval(Duration::from_secs(1));
    control_check.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            ws_message = socket_receiver.next() => {
                let Some(message_result) = ws_message else {
                    break;
                };
                match message_result {
                    Ok(WsMessage::Binary(data)) => {
                        match forward_vnc_client_packet(&mut tcp_writer, &data, || {
                            state.browser_collaboration.has_human_control(&claims)
                        })
                        .await
                        {
                            Ok(true) => {}
                            Ok(false) => break,
                            Err(error) => {
                                warn!(?error, "failed to write WebSocket data to VNC TCP stream");
                                break;
                            }
                        }
                    }
                    Ok(WsMessage::Text(_)) => {
                        // noVNC speaks binary; ignore text messages.
                    }
                    Ok(WsMessage::Ping(payload)) => {
                        let _ = socket_sender.send(WsMessage::Pong(payload)).await;
                    }
                    Ok(WsMessage::Pong(_)) => {}
                    Ok(WsMessage::Close(_)) => break,
                    Err(error) => {
                        warn!(?error, "WebSocket receive error");
                        break;
                    }
                }
            }
            tcp_read = tcp_reader.read(&mut tcp_buf) => {
                match tcp_read {
                    Ok(0) => break,
                    Ok(n) => {
                        if socket_sender.send(WsMessage::Binary(tcp_buf[..n].to_vec())).await.is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        warn!(?error, "failed to read from VNC TCP stream");
                        break;
                    }
                }
            }
            _ = control_check.tick() => {
                if !state.browser_collaboration.has_human_control(&claims).await {
                    break;
                }
            }
        }
    }

    let _ = socket_sender.send(WsMessage::Close(None)).await;
}

async fn forward_vnc_client_packet<W, Authorize, Authorization>(
    writer: &mut W,
    data: &[u8],
    authorize: Authorize,
) -> std::io::Result<bool>
where
    W: AsyncWrite + Unpin,
    Authorize: FnOnce() -> Authorization,
    Authorization: Future<Output = bool>,
{
    // The periodic check closes idle/stale bridges, but it is not an input
    // authorization boundary. Re-evaluate the exact live collaboration owner
    // immediately before forwarding every client-to-VNC packet.
    if !authorize().await {
        return Ok(false);
    }
    writer.write_all(data).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn vnc_client_packets_recheck_live_control_before_every_write() {
        let (mut writer, mut target) = tokio::io::duplex(64);

        assert!(
            forward_vnc_client_packet(&mut writer, b"allowed", || async { true })
                .await
                .expect("authorized write")
        );
        assert!(
            !forward_vnc_client_packet(&mut writer, b"blocked", || async { false })
                .await
                .expect("revoked write")
        );

        let mut allowed = [0_u8; 7];
        target
            .read_exact(&mut allowed)
            .await
            .expect("read authorized packet");
        assert_eq!(&allowed, b"allowed");
        let mut blocked = [0_u8; 7];
        assert!(
            timeout(Duration::from_millis(20), target.read_exact(&mut blocked))
                .await
                .is_err()
        );
    }

    async fn local_http_response(body: &[u8], include_content_length: bool) -> reqwest::Response {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind local HTTP server");
        let address = listener.local_addr().expect("local server address");
        let body = body.to_vec();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept HTTP client");
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request).await;
            let headers = if include_content_length {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            } else {
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string()
            };
            stream
                .write_all(headers.as_bytes())
                .await
                .expect("write HTTP headers");
            stream.write_all(&body).await.expect("write HTTP body");
        });
        reqwest::Client::new()
            .get(format!("http://{address}/"))
            .send()
            .await
            .expect("request local HTTP server")
    }

    #[tokio::test]
    async fn bounded_http_body_rejects_declared_and_streamed_oversize_responses() {
        let declared = local_http_response(b"123456789", true).await;
        assert!(read_bounded_http_body(declared, 8, "test").await.is_err());

        let streamed = local_http_response(b"123456789", false).await;
        assert!(read_bounded_http_body(streamed, 8, "test").await.is_err());

        let allowed = local_http_response(b"12345678", false).await;
        assert_eq!(
            read_bounded_http_body(allowed, 8, "test")
                .await
                .expect("bounded body"),
            b"12345678"
        );
    }

    #[test]
    fn tail_browser_actions_returns_only_events_after_the_cursor() {
        let first = b"{\"seq\":1,\"ts\":10,\"type\":\"navigate\",\"label\":\"Go\",\"url\":\"https://x.test\"}\n";
        let second = b"{\"seq\":2,\"ts\":20,\"type\":\"click\",\"label\":\"Click Apply\",\"x\":40,\"y\":12,\"viewportW\":1280,\"viewportH\":640}\n";
        let mut log = Vec::new();
        log.extend_from_slice(first);
        log.extend_from_slice(second);

        // Fresh poll: everything, cursor advances to the end.
        let all = tail_browser_actions(&log, 0, false);
        assert_eq!(all.actions.len(), 2);
        assert_eq!(all.cursor, log.len() as u64);
        assert_eq!(all.actions[1].action_type, "click");
        assert_eq!(all.actions[1].x, Some(40.0));
        assert_eq!(all.actions[1].viewport_h, Some(640.0));

        // Resume from the first line's end: only the click, cursor unchanged.
        let tail = tail_browser_actions(&log[first.len()..], first.len() as u64, false);
        assert_eq!(tail.actions.len(), 1);
        assert_eq!(tail.actions[0].seq, 2);
        assert_eq!(tail.cursor, log.len() as u64);
    }

    #[test]
    fn browser_actions_preserve_exact_page_identity_in_the_response() {
        let action = parse_browser_action_line(
            r#"{"seq":1,"type":"click","pageId":"target_A-1","x":40,"y":12}"#,
        )
        .expect("parse scoped action");
        assert_eq!(action.page_id.as_deref(), Some("target_A-1"));
        let response = serde_json::to_value(action).expect("serialize action");
        assert_eq!(response["pageId"], "target_A-1");
    }

    #[test]
    fn browser_actions_leave_legacy_and_invalid_page_ids_unscoped() {
        for page_id in [
            JsonValue::Null,
            serde_json::json!(false),
            serde_json::json!(""),
            serde_json::json!(" target_A-1 "),
            serde_json::json!("target/A-1"),
            serde_json::json!("x".repeat(BROWSER_ACTION_PAGE_ID_MAX_BYTES + 1)),
        ] {
            let line = serde_json::json!({"seq": 1, "type": "click", "pageId": page_id});
            let action = parse_browser_action_line(&line.to_string()).expect("parse action");
            assert!(action.page_id.is_none());
        }
        let legacy =
            parse_browser_action_line(r#"{"seq":1,"type":"click"}"#).expect("parse legacy action");
        assert!(legacy.page_id.is_none());
        assert!(serde_json::to_value(legacy).unwrap()["pageId"].is_null());
    }

    fn human_input_action_fixture() -> JsonValue {
        serde_json::json!({
            "seq": 1,
            "type": "human_input",
            "pageId": "page-1",
            "humanInputRequest": {
                "version": 1,
                "handoffId": "00000000-0000-4000-8000-000000000001",
                "runId": "00000000-0000-4000-8000-000000000002",
                "initiatorUserId": "00000000-0000-4000-8000-000000000003",
                "browserPageId": "page-1",
                "origin": "https://example.test",
                "createdAtMs": 1000,
                "expiresAtMs": 601000,
                "fields": [{"label": "Highlighted field 1"}]
            }
        })
    }

    #[test]
    fn browser_actions_preserve_only_page_bound_human_input_guidance() {
        let mut value = human_input_action_fixture();
        let action = parse_browser_action_line(&value.to_string()).expect("valid handoff");
        let response = serde_json::to_value(action).expect("serialize handoff");
        assert_eq!(response["humanInputRequest"], value["humanInputRequest"]);

        value["pageId"] = serde_json::json!("other-page");
        assert!(parse_browser_action_line(&value.to_string()).is_none());
        value["pageId"] = JsonValue::Null;
        assert!(parse_browser_action_line(&value.to_string()).is_none());

        value["type"] = serde_json::json!("click");
        let action = parse_browser_action_line(&value.to_string()).expect("ordinary action");
        assert!(action.human_input_request.is_none());
        let response = serde_json::to_value(action).expect("serialize ordinary action");
        assert!(response.get("humanInputRequest").is_none());
    }

    #[test]
    fn browser_actions_reject_malformed_or_unbounded_human_input_guidance() {
        for (key, invalid) in [
            ("version", serde_json::json!(2)),
            ("handoffId", serde_json::json!("not-a-uuid")),
            (
                "runId",
                serde_json::json!("00000000-0000-4000-8000-00000000000A"),
            ),
            ("initiatorUserId", serde_json::json!("")),
            ("browserPageId", serde_json::json!(" page-1")),
            ("origin", serde_json::json!("https://example.test/path")),
            (
                "origin",
                serde_json::json!("https://user:password@example.test"),
            ),
            ("origin", serde_json::json!("file:///tmp/example")),
            ("origin", serde_json::json!("https://example.test/")),
            ("createdAtMs", serde_json::json!(0)),
            ("createdAtMs", serde_json::json!(1.5)),
            ("expiresAtMs", serde_json::json!(1000)),
            ("expiresAtMs", serde_json::json!(601001)),
            ("expiresAtMs", serde_json::json!(9_007_199_254_740_992_u64)),
            ("fields", serde_json::json!([])),
            ("fields", serde_json::json!([{"label": ""}])),
            ("fields", serde_json::json!([{"label": "ü".repeat(41)}])),
            ("fields", serde_json::json!([{"label": "\n"}])),
            (
                "fields",
                serde_json::json!([{"label": "Field", "value": "must not be forwarded"}]),
            ),
            ("instructions", serde_json::json!("must not be forwarded")),
        ] {
            let mut value = human_input_action_fixture();
            value["humanInputRequest"][key] = invalid;
            assert!(
                parse_browser_action_line(&value.to_string()).is_none(),
                "accepted {key}"
            );
        }
        let mut value = human_input_action_fixture();
        value["humanInputRequest"]["fields"] = serde_json::json!((0..9)
            .map(|_| serde_json::json!({"label": "Field"}))
            .collect::<Vec<_>>());
        assert!(parse_browser_action_line(&value.to_string()).is_none());
        value.as_object_mut().unwrap().remove("humanInputRequest");
        assert!(parse_browser_action_line(&value.to_string()).is_none());
    }

    #[test]
    fn tail_browser_actions_leaves_a_torn_trailing_line_for_the_next_poll() {
        // The agent appended a complete line, then a second line the server read
        // mid-write (no trailing newline yet).
        let complete = b"{\"seq\":1,\"ts\":1,\"type\":\"navigate\",\"label\":\"Go\"}\n";
        let torn = b"{\"seq\":2,\"ts\":2,\"type\":\"cli"; // partial, no newline
        let mut log = Vec::new();
        log.extend_from_slice(complete);
        log.extend_from_slice(torn);

        let first = tail_browser_actions(&log, 0, false);
        assert_eq!(first.actions.len(), 1, "only the complete line is returned");
        assert_eq!(
            first.cursor,
            complete.len() as u64,
            "cursor stops before the torn line, not at end-of-file"
        );

        // Next poll: the rest of line 2 has now been flushed with its newline.
        log.extend_from_slice(b"ck\",\"label\":\"Click\"}\n");
        let second = tail_browser_actions(&log[first.cursor as usize..], first.cursor, false);
        assert_eq!(
            second.actions.len(),
            1,
            "the previously-torn line is now delivered"
        );
        assert_eq!(second.actions[0].seq, 2);
        assert_eq!(second.cursor, log.len() as u64);
    }

    #[test]
    fn tail_browser_actions_resets_when_the_log_was_truncated() {
        // A new session truncates the file, so a stale (larger) cursor must
        // re-sync from the start rather than read past the end.
        let log = b"{\"seq\":1,\"ts\":1,\"type\":\"navigate\",\"label\":\"Go\"}\n";
        let plan = browser_actions_read_plan(log.len() as u64, 9_999);
        let result = tail_browser_actions(log, plan.start, plan.discard_initial_partial_line);
        assert_eq!(result.actions.len(), 1);
        assert_eq!(result.cursor, log.len() as u64);
    }

    #[test]
    fn tail_browser_actions_skips_unparseable_and_typeless_lines_and_caps_output() {
        let mut log = Vec::new();
        log.extend_from_slice(b"not json at all\n");
        log.extend_from_slice(b"{\"seq\":1,\"label\":\"no type field\"}\n");
        for seq in 0..(BROWSER_ACTIONS_MAX_RETURNED + 25) {
            log.extend_from_slice(
                format!("{{\"seq\":{seq},\"ts\":1,\"type\":\"scroll\",\"label\":\"Scroll\"}}\n")
                    .as_bytes(),
            );
        }
        let result = tail_browser_actions(&log, 0, false);
        assert_eq!(result.actions.len(), BROWSER_ACTIONS_MAX_RETURNED);
        // The cap keeps the MOST RECENT events (drops from the front).
        assert_eq!(
            result.actions.last().unwrap().label,
            "Scroll",
            "kept the newest events"
        );
        assert!(result.actions.iter().all(|a| a.action_type == "scroll"));
    }

    #[test]
    fn browser_actions_read_plan_bounds_io_and_preserves_absolute_offsets() {
        let file_len = BROWSER_ACTIONS_READ_WINDOW_BYTES as u64 + 4_096;
        let plan = browser_actions_read_plan(file_len, 0);
        assert_eq!(plan.start, 4_096);
        assert_eq!(plan.length, BROWSER_ACTIONS_READ_WINDOW_BYTES);
        assert!(plan.discard_initial_partial_line);

        let near_tail = browser_actions_read_plan(file_len, file_len - 100);
        assert_eq!(near_tail.start, file_len - 100);
        assert_eq!(near_tail.length, 100);
        assert!(!near_tail.discard_initial_partial_line);

        let after_truncation = browser_actions_read_plan(file_len, file_len + 1);
        assert_eq!(after_truncation, plan);
    }

    #[test]
    fn tail_browser_actions_discards_a_partial_window_prefix_with_absolute_cursor() {
        let bytes = b"middle of old line\n{\"seq\":9,\"ts\":1,\"type\":\"click\",\"label\":\"Recent\"}\npartial";
        let absolute_start = 8_000;
        let result = tail_browser_actions(bytes, absolute_start, true);
        let last_newline = bytes.iter().rposition(|byte| *byte == b'\n').unwrap();
        assert_eq!(result.actions.len(), 1);
        assert_eq!(result.actions[0].seq, 9);
        assert_eq!(result.cursor, absolute_start + last_newline as u64 + 1);
    }

    #[tokio::test]
    async fn read_browser_actions_returns_only_the_recent_bounded_window() {
        let sandbox = tempfile::tempdir().expect("create temp dir");
        let path = sandbox.path().join("actions.jsonl");
        let mut log = vec![b'x'; BROWSER_ACTIONS_READ_WINDOW_BYTES + 128];
        log.push(b'\n');
        for seq in 0..250 {
            log.extend_from_slice(
                format!("{{\"seq\":{seq},\"ts\":1,\"type\":\"scroll\",\"label\":\"Recent\"}}\n")
                    .as_bytes(),
            );
        }
        std::fs::write(&path, &log).expect("write actions log");

        let result = read_browser_actions(path.to_str().unwrap(), 0)
            .await
            .expect("read bounded actions");
        assert_eq!(result.actions.len(), BROWSER_ACTIONS_MAX_RETURNED);
        assert_eq!(result.actions.last().map(|action| action.seq), Some(249));
        assert_eq!(result.cursor, log.len() as u64);
    }

    #[test]
    fn browser_action_strings_are_utf8_safe_and_bounded() {
        let label = "🦀".repeat(BROWSER_ACTION_LABEL_MAX_BYTES);
        let url = format!(
            "https://example.com/{}",
            "ü".repeat(BROWSER_ACTION_URL_MAX_BYTES)
        );
        let line = serde_json::json!({
            "seq": 1,
            "ts": 1,
            "type": "navigate",
            "label": label,
            "url": url
        })
        .to_string();
        let action = parse_browser_action_line(&line).expect("parse action");
        assert!(action.label.len() <= BROWSER_ACTION_LABEL_MAX_BYTES);
        assert!(!action.label.contains('\u{fffd}'));
        let action_url = action.url.unwrap();
        assert!(action_url.len() <= BROWSER_ACTION_URL_MAX_BYTES);
        assert!(!action_url.contains('\u{fffd}'));
    }

    #[test]
    fn browser_target_placeholder_detects_blank_tabs() {
        let placeholder = BrowserCdpTargetDescriptor {
            id: "blank".to_string(),
            target_type: "page".to_string(),
            title: String::new(),
            url: "about:blank".to_string(),
            websocket_debugger_url: None,
        };
        let real_page = BrowserCdpTargetDescriptor {
            id: "wiki".to_string(),
            target_type: "page".to_string(),
            title: "Pear".to_string(),
            url: "https://en.wikipedia.org/wiki/Pear".to_string(),
            websocket_debugger_url: None,
        };

        assert!(browser_target_is_placeholder(&placeholder));
        assert!(!browser_target_is_placeholder(&real_page));
    }

    #[test]
    fn browser_cdp_targets_are_count_and_descriptor_bounded() {
        let mut targets: Vec<_> = (0..BROWSER_CDP_TARGET_MAX_COUNT + 20)
            .map(|index| BrowserCdpTargetDescriptor {
                id: format!("page-{index}"),
                target_type: "page".to_string(),
                title: format!("Page {index}"),
                url: format!("https://example.com/{index}"),
                websocket_debugger_url: Some(format!("ws://127.0.0.1/page/{index}")),
            })
            .collect();
        targets[0].title = "🦀".repeat(BROWSER_CDP_TARGET_TITLE_MAX_BYTES);
        targets[0].url = format!(
            "https://example.com/{}",
            "ü".repeat(BROWSER_CDP_TARGET_URL_MAX_BYTES)
        );
        let normalized = normalize_browser_cdp_targets(targets);

        assert_eq!(normalized.len(), BROWSER_CDP_TARGET_MAX_COUNT);
        assert!(normalized
            .iter()
            .all(|target| target.title.len() <= BROWSER_CDP_TARGET_TITLE_MAX_BYTES));
        assert!(normalized
            .iter()
            .all(|target| target.url.len() <= BROWSER_CDP_TARGET_URL_MAX_BYTES));
        assert!(normalized
            .iter()
            .all(|target| !target.title.contains('\u{fffd}') && !target.url.contains('\u{fffd}')));

        let normal = BrowserCdpTargetDescriptor {
            id: "normal".to_string(),
            target_type: "page".to_string(),
            title: "Instafy Studio".to_string(),
            url: "https://example.com/path?q=1".to_string(),
            websocket_debugger_url: None,
        };
        let normalized = normalize_browser_cdp_targets(vec![normal]);
        assert_eq!(normalized[0].title, "Instafy Studio");
        assert_eq!(normalized[0].url, "https://example.com/path?q=1");
    }

    #[test]
    fn browser_capabilities_serialize_the_versioned_rfb_contract() {
        let capabilities = serde_json::to_value(browser_capabilities(true, false, None, None))
            .expect("serialize capabilities");
        assert_eq!(
            capabilities,
            serde_json::json!({
                "version": 2,
                "approvalModes": ["ask", "routine"],
                "viewerKinds": ["rfb"],
                "preferredViewer": "rfb",
                "viewportOnly": true,
                "rfb": {
                    "renderScale": 1.0,
                    "maxFramebufferPixels": 8294400
                },
                "controls": {
                    "navigate": true,
                    "history": true,
                    "reload": true,
                    "focusPage": true
                }
            })
        );
    }

    #[test]
    fn browser_capabilities_prefer_feature_gated_cdp_screencast_with_rfb_fallback() {
        let capabilities = serde_json::to_value(browser_capabilities(true, true, None, None))
            .expect("serialize capabilities");
        assert_eq!(
            capabilities.get("viewerKinds"),
            Some(&serde_json::json!(["cdp-screencast", "rfb"]))
        );
        assert_eq!(
            capabilities.get("preferredViewer"),
            Some(&serde_json::json!("cdp-screencast"))
        );
    }

    #[test]
    fn browser_capabilities_prefer_webrtc_and_keep_pixel_fallbacks() {
        let capabilities = serde_json::to_value(browser_capabilities(
            true,
            true,
            Some(crate::browser_webrtc::BrowserWebRtcCapabilities {
                ice_servers: Vec::new(),
                relay_only: false,
            }),
            Some("webrtc"),
        ))
        .expect("serialize capabilities");
        assert_eq!(
            capabilities.get("viewerKinds"),
            Some(&serde_json::json!(["webrtc", "cdp-screencast", "rfb"]))
        );
        assert_eq!(
            capabilities.get("preferredViewer"),
            Some(&serde_json::json!("webrtc"))
        );
        assert_eq!(
            capabilities.get("webrtc"),
            Some(&serde_json::json!({ "iceServers": [], "relayOnly": false }))
        );
    }

    #[test]
    fn browser_page_filter_only_includes_placeholders_when_requested() {
        let target = |id: &str, url: &str| BrowserCdpTargetDescriptor {
            id: id.to_string(),
            target_type: "page".to_string(),
            title: String::new(),
            url: url.to_string(),
            websocket_debugger_url: None,
        };

        let filtered = filter_browser_page_targets(
            vec![
                target("blank", "about:blank"),
                target("real", "https://example.com/"),
            ],
            false,
        );
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "real");

        let included = filter_browser_page_targets(
            vec![
                target("blank", "about:blank"),
                target("real", "https://example.com/"),
            ],
            true,
        );
        assert_eq!(included.len(), 2);

        let hidden_blank = filter_browser_page_targets(vec![target("blank", "about:blank")], false);
        assert!(hidden_blank.is_empty());
    }

    #[test]
    fn browser_page_serialization_includes_camel_case_history_controls() {
        let page = BrowserPageResponse {
            id: "page-1".to_string(),
            url: "https://example.com/".to_string(),
            host: "example.com".to_string(),
            label: "Example".to_string(),
            title: Some("Example".to_string()),
            is_active: true,
            can_go_back: true,
            can_go_forward: false,
        };
        let value = serde_json::to_value(page).expect("serialize browser page");
        assert_eq!(
            value.get("canGoBack").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            value.get("canGoForward").and_then(|value| value.as_bool()),
            Some(false)
        );
        assert!(value.get("can_go_back").is_none());
    }

    #[test]
    fn browser_navigation_urls_allow_only_safe_page_schemes_without_credentials() {
        assert_eq!(
            normalize_browser_navigation_url(" about:blank ").expect("about blank"),
            "about:blank"
        );
        assert_eq!(
            normalize_browser_navigation_url("https://example.com/docs?q=1").expect("https URL"),
            "https://example.com/docs?q=1"
        );
        assert!(normalize_browser_navigation_url("https://user:secret@example.com/").is_err());
        assert!(normalize_browser_navigation_url("javascript:alert(1)").is_err());
        assert!(normalize_browser_navigation_url("file:///etc/passwd").is_err());
        assert!(normalize_browser_navigation_url("chrome://settings/").is_err());
        assert!(normalize_browser_navigation_url("about:config").is_err());
    }

    #[test]
    fn browser_commands_reject_urls_for_non_navigation_actions() {
        let command = BrowserPageCommandRequest {
            action: BrowserPageCommandAction::Reload,
            url: Some("https://example.com".to_string()),
        };
        assert!(validate_browser_page_command(&command).is_err());
    }

    #[test]
    fn browser_command_body_rejects_unlisted_actions_and_fields() {
        assert!(
            serde_json::from_value::<BrowserPageCommandRequest>(serde_json::json!({
                "action": "evaluate",
                "url": "https://example.com/"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<BrowserPageCommandRequest>(serde_json::json!({
                "action": "reload",
                "expression": "document.cookie"
            }))
            .is_err()
        );
    }

    #[test]
    fn browser_navigation_history_exposes_only_direction_availability() {
        let history = parse_browser_navigation_history(&serde_json::json!({
            "currentIndex": 1,
            "entries": [{"id": 10}, {"id": 11}, {"id": 12}]
        }))
        .expect("valid navigation history");
        let state = browser_navigation_state(&history);
        assert!(state.can_go_back);
        assert!(state.can_go_forward);
        assert_eq!(
            browser_history_destination(&history, BrowserPageCommandAction::Back),
            Some(10)
        );
        assert_eq!(
            browser_history_destination(&history, BrowserPageCommandAction::Forward),
            Some(12)
        );

        assert!(parse_browser_navigation_history(&serde_json::json!({
            "currentIndex": 3,
            "entries": [{"id": 10}]
        }))
        .is_none());
    }

    #[test]
    fn derive_browser_page_label_prefers_human_title_prefix() {
        assert_eq!(
            derive_browser_page_label(
                Some("BBC Home - Breaking News, World News, US News"),
                "bbc.com",
                "https://www.bbc.com/"
            ),
            "BBC Home".to_string()
        );
        assert_eq!(
            derive_browser_page_label(
                None,
                "en.wikipedia.org",
                "https://en.wikipedia.org/wiki/Pear"
            ),
            "en.wikipedia.org".to_string()
        );
    }
}
