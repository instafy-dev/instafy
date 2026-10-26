//! **Send page to Octo** on the Shared Browser: `POST /browser/pages/:id/capture`.
//!
//! A person with `browser.control` reads the page they are looking at once,
//! to attach it to their next chat message. The page is read and masked on
//! this machine, inside an isolated world of the page that page scripts cannot
//! reach, with the same redaction rules as an agent snapshot
//! (`@instafy/browser-action-policy`, `pageCapture.js` and `redaction.js`).
//! Only the masked address, title and text leave the host. A secret screen,
//! a page the browser already withholds from the agent (marked on the page, or
//! opened by a credential step the agent's run recorded), or a page that could
//! not be checked answers without any text.
//!
//! Each request reads one page once. Nothing is kept, no listener stays on
//! the page, and no agent authority, approval or control changes: the route
//! grants no standing read of the browser.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::header::CACHE_CONTROL;
use axum::response::{IntoResponse, Json, Response};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as TungMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::browser::{fetch_browser_cdp_targets, BrowserTargetPathParams};
use crate::browser_approval::CarriedWithholding;
use crate::browser_host::BrowserHostReady;
use crate::error::OriginError;
use crate::routes::AppState;

/// Reading a large page (its secret checks visit up to 20,000 elements) takes
/// longer than one CDP command, but stays bounded.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
/// `pageCapture.js` keeps at most 50,000 characters of text; a UTF-8 character
/// is at most four bytes.
const MAX_TEXT_BYTES: usize = 50_000 * 4;
const MAX_TITLE_BYTES: usize = 1_000 * 4;
const MAX_URL_BYTES: usize = 8_192 * 4;
/// The name of the isolated world. Each capture creates a fresh one.
const CAPTURE_WORLD_NAME: &str = "instafy-sent-page";

/// Whether the agent's Shared Browser controller marked this document as
/// withheld (a secret screen, or a page a credential step ran on). The mark
/// lives on the page's own `document`, so it is read in the main world, the
/// way `shared-browser-cli.js` reads it. Anything but a plain `false` counts
/// as marked.
const WITHHELD_DOCUMENT_EXPRESSION: &str = r#"(() => {
  try {
    const key = Symbol.for("instafy.sharedBrowser.withheldDocument");
    return Object.getOwnPropertyDescriptor(document, key) !== undefined || !Object.isExtensible(document);
  } catch (_) {
    return true;
  }
})()"#;

/// The page reader the hosting process supplies: `redaction.js` and
/// `pageCapture.js`, each wrapped so it publishes its API on `globalThis`.
/// Without it the route answers 404, like a runtime that predates it.
pub type BrowserPageCaptureScript = Arc<str>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapturedPage {
    url: String,
    title: String,
    text: String,
    secret_screen: bool,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPageCaptureResponse {
    page_id: String,
    url: String,
    title: String,
    text: String,
    secret_screen: bool,
    truncated: bool,
    /// When this host read the page (RFC 3339, UTC).
    read_at: String,
}

fn capture_expression(script: &str, withhold: bool) -> String {
    format!(
        "{script}\n;(() => {{\n  const capture = globalThis.__instafyBrowserPageCapture;\n  const redaction = globalThis.__instafyBrowserRedaction;\n  if (!capture || !redaction) return null;\n  return capture.captureSentPage(redaction, {{ withhold: {withhold} }});\n}})()"
    )
}

/// One CDP connection to a page target, for a short series of commands.
struct CdpSession {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: i64,
}

impl CdpSession {
    async fn connect(websocket_url: &str) -> Result<Self, OriginError> {
        let (socket, _response) = connect_async(websocket_url).await.map_err(|error| {
            OriginError::unavailable(format!("browser cdp connection failed: {error}"))
        })?;
        Ok(Self { socket, next_id: 0 })
    }

    async fn call(
        &mut self,
        method: &'static str,
        params: JsonValue,
    ) -> Result<JsonValue, OriginError> {
        self.next_id += 1;
        let id = self.next_id;
        let command = serde_json::json!({ "id": id, "method": method, "params": params });
        self.socket
            .send(TungMessage::Text(command.to_string()))
            .await
            .map_err(|error| {
                OriginError::unavailable(format!("browser cdp command failed: {error}"))
            })?;
        while let Some(message) = self.socket.next().await {
            let message = message.map_err(|error| {
                OriginError::unavailable(format!("browser cdp response failed: {error}"))
            })?;
            let payload = match message {
                TungMessage::Text(text) => serde_json::from_str::<JsonValue>(&text).ok(),
                TungMessage::Binary(bytes) => serde_json::from_slice::<JsonValue>(&bytes).ok(),
                TungMessage::Ping(payload) => {
                    self.socket
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
            let Some(payload) = payload else { continue };
            // Events and answers to other commands are not ours.
            if payload.get("id").and_then(JsonValue::as_i64) != Some(id) {
                continue;
            }
            if payload.get("error").is_some() {
                // CDP error text can quote the page; it is not passed on.
                return Err(OriginError::unavailable(format!(
                    "browser cdp rejected {method}"
                )));
            }
            return Ok(payload.get("result").cloned().unwrap_or(JsonValue::Null));
        }
        Err(OriginError::unavailable(
            "browser cdp closed before responding",
        ))
    }

    async fn close(mut self) {
        let _ = self.socket.close(None).await;
    }
}

/// The main frame's id and loader id. The loader id names one loaded document:
/// it changes with every new document and page scripts cannot set it.
fn main_frame_identity(frame_tree: &JsonValue) -> Option<(String, String)> {
    let frame = frame_tree.get("frameTree")?.get("frame")?;
    let id = frame.get("id")?.as_str()?.trim();
    let loader = frame.get("loaderId")?.as_str()?.trim();
    let valid = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    };
    (valid(id) && valid(loader)).then(|| (id.to_string(), loader.to_string()))
}

fn evaluation_value(result: &JsonValue) -> Result<&JsonValue, OriginError> {
    if result.get("exceptionDetails").is_some() {
        // The page may have broken the read; its message is not passed on.
        return Err(OriginError::unavailable("the page could not be read"));
    }
    Ok(result
        .get("result")
        .and_then(|value| value.get("value"))
        .unwrap_or(&JsonValue::Null))
}

/// Checks what the isolated world returned. The script bounds every field;
/// a value over those bounds was not produced by it and is refused.
fn parse_captured_page(value: &JsonValue) -> Result<CapturedPage, OriginError> {
    if value.get("unsupported").and_then(JsonValue::as_bool) == Some(true) {
        return Err(OriginError::conflict("this tab has no web page to send"));
    }
    let page = serde_json::from_value::<CapturedPage>(value.clone())
        .map_err(|_| OriginError::unavailable("the page could not be read"))?;
    if page.url.len() > MAX_URL_BYTES
        || page.title.len() > MAX_TITLE_BYTES
        || page.text.len() > MAX_TEXT_BYTES
        || (page.secret_screen && (!page.text.is_empty() || !page.title.is_empty()))
    {
        return Err(OriginError::unavailable("the page could not be read"));
    }
    match reqwest::Url::parse(&page.url) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => Ok(page),
        // A withheld page whose address could not be masked has none.
        _ if page.secret_screen && page.url.is_empty() => Ok(page),
        _ => Err(OriginError::unavailable("the page could not be read")),
    }
}

/// `carried` reads the agent's run record of a page a credential step opens;
/// it is read after the page, like the controller's own snapshots do.
async fn capture_page(
    websocket_url: &str,
    script: &str,
    carried: impl Fn() -> CarriedWithholding,
) -> Result<CapturedPage, OriginError> {
    let mut session = CdpSession::connect(websocket_url).await?;
    let result = async {
        let (frame_id, loader_before) = main_frame_identity(
            &session
                .call("Page.getFrameTree", serde_json::json!({}))
                .await?,
        )
        .ok_or_else(|| OriginError::unavailable("the page could not be read"))?;
        let withheld = session
            .call(
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": WITHHELD_DOCUMENT_EXPRESSION,
                    "returnByValue": true,
                    "awaitPromise": false,
                    "userGesture": false,
                    "silent": true,
                }),
            )
            .await
            .ok()
            .and_then(|result| evaluation_value(&result).ok().and_then(JsonValue::as_bool))
            != Some(false);
        let world = session
            .call(
                "Page.createIsolatedWorld",
                serde_json::json!({
                    "frameId": frame_id,
                    "worldName": CAPTURE_WORLD_NAME,
                    "grantUniveralAccess": false,
                }),
            )
            .await?;
        let context_id = world
            .get("executionContextId")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| OriginError::unavailable("the page could not be read"))?;
        let evaluated = session
            .call(
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": capture_expression(script, withheld),
                    "contextId": context_id,
                    "returnByValue": true,
                    "awaitPromise": false,
                    "userGesture": false,
                    "silent": true,
                }),
            )
            .await?;
        let page = parse_captured_page(evaluation_value(&evaluated)?)?;
        // The text must describe one document: a page that loaded while it was
        // read is refused instead of mixing two pages' answers.
        let after = main_frame_identity(
            &session
                .call("Page.getFrameTree", serde_json::json!({}))
                .await?,
        );
        if after.as_ref().map(|(_, loader)| loader.as_str()) != Some(loader_before.as_str()) {
            return Err(OriginError::conflict(
                "the page changed while it was being read; try again",
            ));
        }
        // The page a credential step opened stays withheld until the agent's
        // controller marks it, as the agent's own next snapshot would.
        if !page.secret_screen && carried().withholds(&loader_before) {
            return Ok(CapturedPage {
                url: page.url,
                title: String::new(),
                text: String::new(),
                secret_screen: true,
                truncated: false,
            });
        }
        Ok(page)
    }
    .await;
    session.close().await;
    result
}

/// `POST /browser/pages/:page_id/capture`: reads one page once for the person
/// who asked. See the module documentation.
pub(crate) async fn handle_browser_page_capture(
    _ready: BrowserHostReady,
    State(state): State<AppState>,
    Path(params): Path<BrowserTargetPathParams>,
) -> Result<Response, OriginError> {
    let Some(script) = state.browser_page_capture_script.clone() else {
        return Err(OriginError::not_found(
            "sending a page is not available on this runtime",
        ));
    };
    let page_id = params.page_id.trim();
    if page_id.is_empty() {
        return Err(OriginError::bad_request("page id is required"));
    }
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
        .ok_or_else(|| OriginError::unavailable("browser page CDP endpoint is unavailable"))?
        .to_string();

    let approvals = state.browser_collaboration.approval_bridge().clone();
    let carried = move || approvals.carried_withholding();
    let page = timeout(
        CAPTURE_TIMEOUT,
        capture_page(&websocket_url, &script, carried),
    )
    .await
    .map_err(|_| OriginError::unavailable("reading the page timed out"))??;
    let response = BrowserPageCaptureResponse {
        page_id: page_id.to_string(),
        url: page.url,
        title: page.title,
        text: page.text,
        secret_screen: page.secret_screen,
        truncated: page.truncated,
        read_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    // Page text is never cached on the way to the person.
    Ok(([(CACHE_CONTROL, "no-store")], Json(response)).into_response())
}

#[cfg(test)]
#[path = "browser_page_capture_tests.rs"]
mod tests;
