//! Instafy's browser on the space's own machine, started on demand.
//!
//! The process that hosts this origin (runtime-agent) owns the browser host
//! and hands the origin a [`BrowserHostHandle`] through
//! [`crate::server::OriginHttpServer::set_browser_host`]. Without a handle
//! (Desktop, the boot-time Shared Browser, the multi-tenant gateway) every
//! route here answers 404 and the browser transports behave as before, apart
//! from a boot-time browser's own guard ([`crate::boot_browser`]).
//!
//! - `GET /browser/host` (`browser.view`) reports the host's state and a few
//!   facts relative to the caller, never anyone's identity.
//! - `POST /browser/host/start` (`browser.control`) asks for a start and
//!   returns at once: 200 when the host is already ready, 202 otherwise.
//! - With a handle, the page, page-command and pixel/input transports answer
//!   503 `browser_host_not_ready` until the host is ready, before any CDP
//!   request or WebSocket upgrade ([`BrowserHostReady`]).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::Extension;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::OriginClaims;
use crate::browser_approval::AgentControlMarkerObservation;
use crate::error::OriginError;
use crate::routes::AppState;

pub const BROWSER_HOST_CONTRACT_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserHostState {
    Idle,
    Starting,
    Ready,
    Stopping,
    Failed,
    Poisoned,
}

#[derive(Clone, Debug)]
pub struct BrowserHostSnapshot {
    pub state: BrowserHostState,
    pub generation: Option<Uuid>, // new per host start; None while Idle
    pub failure: Option<&'static str>, // a token below; Some only in Failed or Poisoned
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BrowserHostCallerFacts {
    pub started_by_caller: bool, // the Starting/Ready generation was started by this subject
    pub other_seen_recently: bool, // another subject was seen within the agent's 30 s grace
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserHostRefusal {
    pub code: &'static str,
    pub message: String,
}

/// Implemented by runtime-agent. No method may await, block on I/O, or take a
/// lock that is held across an await anywhere.
pub trait BrowserHostControl: Send + Sync + 'static {
    fn snapshot(&self) -> BrowserHostSnapshot;
    fn caller_facts(&self, subject: &str) -> BrowserHostCallerFacts;
    /// Single-flight. Never waits for Ready. The first starter is recorded for the generation.
    fn request_start(&self, subject: &str) -> Result<BrowserHostSnapshot, BrowserHostRefusal>;
    /// The subject used the browser now. Only a clock bump; there is no "left" event.
    fn note_seen(&self, subject: &str);
}

pub type BrowserHostHandle = Arc<dyn BrowserHostControl>;

/// The only mode a browser host has in contract version 1.
pub const BROWSER_HOST_MODE_LAZY: &str = "lazy";

/// Refusal codes [`BrowserHostControl::request_start`] returns; origin
/// answers each with 409.
pub const BROWSER_HOST_POISONED_CODE: &str = "browser_host_poisoned";
pub const BROWSER_HOST_STOPPING_CODE: &str = "browser_host_stopping";
/// 503 from a guarded browser transport while the host is not ready.
pub const BROWSER_HOST_NOT_READY_CODE: &str = "browser_host_not_ready";
/// 409 from a start while a pre-stop flush holds the machine's stop fence.
pub const MACHINE_STOPPING_CODE: &str = "machine_stopping";
/// 404 from `/browser/host` and `/browser/host/start` on an origin the process
/// gave no browser host. It tells origin's own answer apart from a 404 that a
/// proxy or a controller in front of it gives.
pub const BROWSER_HOST_ABSENT_CODE: &str = "browser_host_absent";

/// Every failure token a snapshot may carry: the host's own start reasons
/// (`runtime-entrypoint start-browser-host`), then the agent's. Origin
/// reports any other value as `host_error`, so clients only ever see these.
pub const BROWSER_HOST_FAILURE_TOKENS: &[&str] = &[
    "config_invalid",
    "port_reserved",
    "display_in_use",
    "port_in_use",
    "profile_in_use",
    "host_in_use",
    "stack_missing",
    "egress_unavailable",
    "display_failed",
    "chromium_failed",
    "host_error",
    "exited_egress_proxy",
    "exited_display",
    "exited_chromium",
    "exited_unknown",
    "start_timeout",
    "spawn_failed",
    "unconfirmed_shutdown",
];

/// The start body's limit at origin (the controller's proxy allows 4 KiB).
pub(crate) const BROWSER_HOST_START_BODY_LIMIT_BYTES: usize = 1024;

/// `GET /browser/host` and the start's answer. Every flag is relative to the
/// caller, and no subject or user id ever appears in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserHostView {
    version: u8,
    mode: &'static str,
    state: BrowserHostState,
    generation: Option<Uuid>,
    failure: Option<&'static str>,
    started_by_you: bool,
    others_present: bool,
    controlled_by_other: bool,
    agent_run_active: bool,
    agent_run_started_by_you: bool,
}

/// The start body: exactly `{"version":1}`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserHostStartRequest {
    version: u8,
}

impl AppState {
    /// Tell the browser host that `subject` used the browser now. Nothing
    /// happens without a host.
    pub(crate) fn note_browser_host_seen(&self, subject: &str) {
        if let Some(handle) = self.browser_host.as_ref() {
            handle.note_seen(subject);
        }
    }
}

/// Extractor that refuses a browser transport while this machine's browser
/// host is not ready: 503 `browser_host_not_ready` with `Retry-After: 1`.
/// Put it before every other extractor of a guarded handler, so the refusal
/// comes before any CDP request or WebSocket upgrade. It also counts the
/// request as the caller's use of the browser. Without a host it refuses only
/// while a boot-time browser's Chromium is not running
/// ([`crate::boot_browser`]: `browser_restarting` or `browser_stopped`), and
/// otherwise does nothing.
pub(crate) struct BrowserHostReady;

#[axum::async_trait]
impl FromRequestParts<AppState> for BrowserHostReady {
    type Rejection = OriginError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, OriginError> {
        let Some(handle) = state.browser_host.as_ref() else {
            // A boot-time browser says when its Chromium is not running.
            return match state
                .boot_browser
                .as_deref()
                .and_then(crate::boot_browser::refusal)
            {
                Some(refusal) => Err(refusal),
                None => Ok(Self),
            };
        };
        if let Some(claims) = parts.extensions.get::<OriginClaims>() {
            handle.note_seen(&claims.sub);
        }
        if handle.snapshot().state != BrowserHostState::Ready {
            return Err(not_ready());
        }
        Ok(Self)
    }
}

fn not_ready() -> OriginError {
    OriginError::retry_later(
        BROWSER_HOST_NOT_READY_CODE,
        "Instafy's browser is not running",
        1,
    )
}

fn no_host() -> OriginError {
    OriginError::with_report(
        StatusCode::NOT_FOUND,
        BROWSER_HOST_ABSENT_CODE,
        "this machine has no browser host",
        serde_json::json!({}),
    )
}

fn public_failure(snapshot: &BrowserHostSnapshot) -> Option<&'static str> {
    if !matches!(
        snapshot.state,
        BrowserHostState::Failed | BrowserHostState::Poisoned
    ) {
        return None;
    }
    snapshot.failure.map(|token| {
        if BROWSER_HOST_FAILURE_TOKENS.contains(&token) {
            token
        } else {
            "host_error"
        }
    })
}

/// The code and message a start refusal answers with. Only the two
/// documented codes reach clients, each with a fixed message; the host's own
/// message is never passed on, and any other code reads as stopping.
fn public_refusal(refusal: &BrowserHostRefusal) -> (&'static str, &'static str) {
    if refusal.code == BROWSER_HOST_POISONED_CODE {
        (
            BROWSER_HOST_POISONED_CODE,
            "Instafy's browser needs this space's machine to restart before it can open again",
        )
    } else {
        (
            BROWSER_HOST_STOPPING_CODE,
            "Instafy's browser is stopping; try again in a moment",
        )
    }
}

/// The caller-relative view of `snapshot`.
pub(crate) async fn host_view(
    state: &AppState,
    handle: &dyn BrowserHostControl,
    snapshot: BrowserHostSnapshot,
    subject: &str,
) -> BrowserHostView {
    let facts = handle.caller_facts(subject);
    let hub = &state.browser_collaboration;
    let (present_in_hub, controlled_by_other) = hub.occupancy_for(subject).await;
    let (agent_run_active, agent_run_started_by_you) =
        match hub.approval_bridge().read_agent_control().await {
            AgentControlMarkerObservation::Active(marker) => {
                (true, marker.initiator_user_id == subject)
            }
            AgentControlMarkerObservation::Inactive => (false, false),
            // An unreadable marker cannot prove that no run holds the
            // browser: active, and not the caller's.
            AgentControlMarkerObservation::Unavailable(_) => (true, false),
        };
    BrowserHostView {
        version: BROWSER_HOST_CONTRACT_VERSION,
        mode: BROWSER_HOST_MODE_LAZY,
        state: snapshot.state,
        generation: snapshot.generation,
        failure: public_failure(&snapshot),
        started_by_you: facts.started_by_caller,
        others_present: present_in_hub || facts.other_seen_recently,
        controlled_by_other,
        agent_run_active,
        agent_run_started_by_you,
    }
}

fn no_store_json(status: StatusCode, view: BrowserHostView) -> Response {
    let mut response = (status, Json(view)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, max-age=0"),
    );
    response
}

/// `GET /browser/host`.
pub(crate) async fn handle_browser_host(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
) -> Result<Response, OriginError> {
    let handle = state.browser_host.clone().ok_or_else(no_host)?;
    let snapshot = handle.snapshot();
    let view = host_view(&state, handle.as_ref(), snapshot, &claims.sub).await;
    Ok(no_store_json(StatusCode::OK, view))
}

/// `POST /browser/host/start` with `{"version":1}`. Never waits for the
/// host to be ready: 200 when it already is, 202 otherwise.
pub(crate) async fn handle_browser_host_start(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    body: Bytes,
) -> Result<Response, OriginError> {
    let handle = state.browser_host.clone().ok_or_else(no_host)?;
    // Through a map first: serde would also read a struct from an array.
    let request = serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&body)
        .and_then(|object| {
            serde_json::from_value::<BrowserHostStartRequest>(serde_json::Value::Object(object))
        })
        .map_err(|_| OriginError::bad_request("the start body must be {\"version\":1}"))?;
    if request.version != BROWSER_HOST_CONTRACT_VERSION {
        return Err(OriginError::bad_request(
            "unsupported browser host contract version",
        ));
    }
    if state.stopping.is_up() {
        return Err(OriginError::with_report(
            StatusCode::CONFLICT,
            MACHINE_STOPPING_CODE,
            "this machine is stopping; open the browser after it restarts",
            serde_json::json!({}),
        ));
    }
    handle.note_seen(&claims.sub);
    let snapshot = handle.request_start(&claims.sub).map_err(|refusal| {
        let (code, message) = public_refusal(&refusal);
        OriginError::with_report(StatusCode::CONFLICT, code, message, serde_json::json!({}))
    })?;
    let status = if snapshot.state == BrowserHostState::Ready {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    };
    let view = host_view(&state, handle.as_ref(), snapshot, &claims.sub).await;
    Ok(no_store_json(status, view))
}

#[cfg(test)]
#[path = "browser_host_tests.rs"]
mod tests;
