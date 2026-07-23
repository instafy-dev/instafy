mod input;
mod protocol;
mod stream;
mod transport;

use std::time::Duration;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Query, State};
use axum::response::Response;
use axum::Extension;
use protocol::{Viewport, CLIENT_MESSAGE_MAX_BYTES};
use serde::Deserialize;
use tokio::time::timeout;

use crate::auth::{validated_claim_expiry, OriginClaims};
use crate::error::OriginError;
use crate::routes::AppState;
use transport::ResolvedTarget;

const CDP_HTTP_TIMEOUT: Duration = Duration::from_secs(2);
const CDP_TARGET_LIST_MAX_BYTES: usize = 1024 * 1024;
const CDP_TARGET_MAX_COUNT: usize = 128;
const PAGE_ID_MAX_BYTES: usize = 256;
const DEFAULT_VIEWPORT_WIDTH: u32 = 1280;
const DEFAULT_VIEWPORT_HEIGHT: u32 = 720;
const DEFAULT_VIEWPORT_DPR: f64 = 1.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserScreencastQuery {
    page_id: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    dpr: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CdpTargetDescriptor {
    id: String,
    #[serde(rename = "type")]
    target_type: String,
    #[serde(default)]
    url: String,
    #[serde(rename = "webSocketDebuggerUrl", default)]
    websocket_debugger_url: Option<String>,
}

fn feature_flag_enabled(raw: Option<&str>) -> bool {
    matches!(
        raw.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

pub(crate) fn browser_screencast_enabled() -> bool {
    feature_flag_enabled(
        std::env::var("INSTAFY_BROWSER_CDP_SCREENCAST")
            .ok()
            .as_deref(),
    )
}

fn cdp_port() -> u16 {
    std::env::var("INSTAFY_PLAYWRIGHT_CDP_PORT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(9223)
}

fn cdp_base_url() -> String {
    format!("http://127.0.0.1:{}", cdp_port())
}

fn validate_page_id(raw: Option<&str>) -> Result<Option<String>, OriginError> {
    let Some(page_id) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if page_id.len() > PAGE_ID_MAX_BYTES
        || !page_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(OriginError::bad_request("invalid screencast page id"));
    }
    Ok(Some(page_id.to_string()))
}

fn target_is_placeholder(target: &CdpTargetDescriptor) -> bool {
    let normalized = target.url.trim().to_ascii_lowercase();
    normalized.is_empty()
        || normalized == "about:blank"
        || matches!(
            normalized.as_str(),
            "chrome://newtab/" | "chrome://new-tab-page/" | "edge://newtab/"
        )
}

fn validate_cdp_websocket_url(raw: &str) -> Result<String, OriginError> {
    let parsed = reqwest::Url::parse(raw)
        .map_err(|_| OriginError::unavailable("invalid browser CDP websocket endpoint"))?;
    if parsed.scheme() != "ws"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(cdp_port())
    {
        return Err(OriginError::unavailable(
            "browser CDP websocket endpoint is not loopback",
        ));
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Err(OriginError::unavailable(
            "browser CDP websocket endpoint is not loopback",
        ));
    }
    Ok(parsed.to_string())
}

async fn read_bounded_body(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, OriginError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(OriginError::unavailable(
            "browser CDP target list exceeds the size limit",
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        OriginError::unavailable(format!("failed to read browser CDP target list: {error}"))
    })? {
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(OriginError::unavailable(
                "browser CDP target list exceeds the size limit",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn fetch_cdp_targets(state: &AppState) -> Result<Vec<CdpTargetDescriptor>, OriginError> {
    timeout(CDP_HTTP_TIMEOUT, async {
        let response = state
            .http_client
            .get(format!("{}/json/list", cdp_base_url()))
            .send()
            .await
            .map_err(|error| {
                OriginError::unavailable(format!("browser CDP target list unavailable: {error}"))
            })?;
        if !response.status().is_success() {
            return Err(OriginError::unavailable(format!(
                "browser CDP target list unavailable ({})",
                response.status()
            )));
        }
        let body = read_bounded_body(response, CDP_TARGET_LIST_MAX_BYTES).await?;
        let targets = serde_json::from_slice::<Vec<CdpTargetDescriptor>>(&body)
            .map_err(|_| OriginError::unavailable("invalid browser CDP target list"))?;
        Ok(targets
            .into_iter()
            .filter(|target| target.target_type == "page")
            .take(CDP_TARGET_MAX_COUNT)
            .collect())
    })
    .await
    .map_err(|_| OriginError::unavailable("browser CDP target list timed out"))?
}

fn resolve_target(
    targets: Vec<CdpTargetDescriptor>,
    requested_page_id: Option<&str>,
) -> Result<ResolvedTarget, OriginError> {
    let target = if let Some(page_id) = requested_page_id {
        targets.into_iter().find(|target| target.id == page_id)
    } else {
        let selected_index = targets
            .iter()
            .position(|target| !target_is_placeholder(target))
            .unwrap_or(0);
        targets.into_iter().nth(selected_index)
    }
    .ok_or_else(|| OriginError::not_found("browser screencast page not found"))?;

    let websocket_url = target
        .websocket_debugger_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| OriginError::unavailable("browser page CDP endpoint is unavailable"))?;
    Ok(ResolvedTarget {
        id: target.id,
        websocket_url: validate_cdp_websocket_url(websocket_url)?,
    })
}

fn requested_viewport(query: &BrowserScreencastQuery) -> Result<Viewport, OriginError> {
    Viewport::new(
        query.width.unwrap_or(DEFAULT_VIEWPORT_WIDTH),
        query.height.unwrap_or(DEFAULT_VIEWPORT_HEIGHT),
        query.dpr.unwrap_or(DEFAULT_VIEWPORT_DPR),
    )
}

async fn requested_target(
    state: &AppState,
    query: &BrowserScreencastQuery,
) -> Result<ResolvedTarget, OriginError> {
    let requested_page_id = validate_page_id(query.page_id.as_deref())?;
    resolve_target(
        fetch_cdp_targets(state).await?,
        requested_page_id.as_deref(),
    )
}

pub(crate) async fn handle_browser_screencast_ws(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Query(query): Query<BrowserScreencastQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, OriginError> {
    if !browser_screencast_enabled() {
        return Err(OriginError::not_found(
            "browser CDP screencast transport is disabled",
        ));
    }
    validated_claim_expiry(&claims)?;
    let viewport = requested_viewport(&query)?;
    let target = requested_target(&state, &query).await?;
    // Target discovery is asynchronous; use a freshly validated absolute
    // deadline for the upgraded stream rather than extending the token by the
    // time spent resolving its page.
    let expires_at = validated_claim_expiry(&claims)?;
    let pixel_admission = state.browser_collaboration.admit_pixel_stream(&claims)?;
    Ok(ws
        .max_message_size(CLIENT_MESSAGE_MAX_BYTES)
        .max_frame_size(CLIENT_MESSAGE_MAX_BYTES)
        .on_upgrade(move |socket| {
            stream::bridge_screencast(socket, target, viewport, expires_at, pixel_admission)
        }))
}

pub(crate) async fn handle_browser_input_ws(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Query(query): Query<BrowserScreencastQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, OriginError> {
    if !browser_screencast_enabled() {
        return Err(OriginError::not_found(
            "remote browser input transport is disabled",
        ));
    }
    let viewport = requested_viewport(&query)?;
    // Admission precedes target discovery and the WebSocket upgrade. A caller
    // over either signed-surface or runtime capacity therefore never reaches
    // `bridge_input` and cannot allocate another CDP connection.
    let input_admission = state.browser_collaboration.admit_input_stream(&claims)?;
    let target = requested_target(&state, &query).await?;
    // Preserve the signed absolute deadline across asynchronous target
    // discovery. An idle input socket must release its admission/CDP resources
    // at expiry even when it sends no further messages.
    let expires_at = validated_claim_expiry(&claims)?;
    Ok(ws
        .max_message_size(CLIENT_MESSAGE_MAX_BYTES)
        .max_frame_size(CLIENT_MESSAGE_MAX_BYTES)
        .on_upgrade(move |socket| {
            input::bridge_input(
                socket,
                target,
                viewport,
                expires_at,
                state,
                claims,
                input_admission,
            )
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use transport::{InputRateLimit, INPUT_MESSAGES_PER_SECOND};

    fn target(id: &str, url: &str, websocket_url: Option<&str>) -> CdpTargetDescriptor {
        CdpTargetDescriptor {
            id: id.to_string(),
            target_type: "page".to_string(),
            url: url.to_string(),
            websocket_debugger_url: websocket_url.map(str::to_string),
        }
    }

    #[test]
    fn feature_flag_is_explicit_and_case_insensitive() {
        for enabled in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(feature_flag_enabled(Some(enabled)), "{enabled}");
        }
        for disabled in ["", "0", "false", "enabled"] {
            assert!(!feature_flag_enabled(Some(disabled)), "{disabled}");
        }
        assert!(!feature_flag_enabled(None));
    }

    #[test]
    fn target_selection_prefers_real_pages_and_honors_explicit_page_id() {
        let targets = vec![
            target(
                "BLANK",
                "about:blank",
                Some("ws://127.0.0.1:9223/devtools/page/BLANK"),
            ),
            target(
                "REAL",
                "https://example.com/",
                Some("ws://127.0.0.1:9223/devtools/page/REAL"),
            ),
        ];
        assert_eq!(resolve_target(targets, None).expect("target").id, "REAL");

        let explicit = resolve_target(
            vec![target(
                "BLANK",
                "about:blank",
                Some("ws://127.0.0.1:9223/devtools/page/BLANK"),
            )],
            Some("BLANK"),
        )
        .expect("explicit target");
        assert_eq!(explicit.id, "BLANK");
    }

    #[test]
    fn target_websocket_must_be_the_configured_loopback_cdp_port() {
        assert!(validate_cdp_websocket_url("ws://127.0.0.1:9223/devtools/page/ABC").is_ok());
        assert!(validate_cdp_websocket_url("ws://attacker.test:9223/devtools/page/ABC").is_err());
        assert!(validate_cdp_websocket_url("ws://127.0.0.1:9999/devtools/page/ABC").is_err());
        assert!(validate_cdp_websocket_url("wss://127.0.0.1:9223/devtools/page/ABC").is_err());
    }

    #[test]
    fn input_rate_limit_is_bounded_per_window() {
        let mut limit = InputRateLimit::new();
        for _ in 0..INPUT_MESSAGES_PER_SECOND {
            assert!(limit.take());
        }
        assert!(!limit.take());
    }

    #[test]
    fn outbound_frame_limit_is_stricter_than_cdp_default_message_limit() {
        assert_eq!(protocol::FRAME_DATA_MAX_BYTES, 16 * 1024 * 1024);
    }
}
