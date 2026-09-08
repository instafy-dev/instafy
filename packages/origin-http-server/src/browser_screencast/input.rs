use std::time::{Duration, Instant, SystemTime};

use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::time::sleep;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as TungMessage;
use tracing::warn;

use crate::auth::OriginClaims;
use crate::browser_collaboration::InputStreamAdmission;
use crate::routes::AppState;

use super::protocol::{ClientMessage, Viewport};
use super::transport::{
    cdp_command, send_cdp_command_and_wait, send_client_json, InputRateLimit, ResolvedTarget,
};

// Leave enough slack for animation-frame-coalesced pointer events already in
// flight when a handoff arrives, while bounding a former driver's expensive
// per-message authority checks far below the normal 240 fps ingress ceiling.
const REVOKED_INPUT_MESSAGES_PER_SECOND: usize = 16;
const FOCUSED_EDITABLE_REVEAL_TIMEOUT: Duration = Duration::from_secs(2);
const RESIZE_ACK_MAX_BYTES: usize = 16 * 1024;

// This fixed, synchronous operation observes only the current focus, editable
// state, and geometry. Never read a field value, change focus, or schedule work
// that could execute after this input participant has yielded control.
const REVEAL_FOCUSED_EDITABLE_SCRIPT: &str = r#"(() => {
  let element = document.activeElement;
  for (let depth = 0; depth < 32 && element?.shadowRoot?.activeElement; depth += 1) {
    element = element.shadowRoot.activeElement;
  }
  if (!(element instanceof HTMLElement) || !element.isConnected) return;
  const textInputTypes = ['text', 'search', 'tel', 'url', 'email', 'password', 'number', 'date', 'datetime-local', 'time', 'month', 'week'];
  const editable = element instanceof HTMLTextAreaElement
    ? !element.disabled && !element.readOnly
    : element instanceof HTMLInputElement
      ? !element.disabled && !element.readOnly && textInputTypes.includes(element.type)
      : element.isContentEditable;
  if (!editable) return;
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return;
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const left = viewport?.offsetLeft ?? 0;
  const bottom = top + (viewport?.height ?? window.innerHeight);
  const right = left + (viewport?.width ?? window.innerWidth);
  if (rect.top >= top && rect.bottom <= bottom && rect.left >= left && rect.right <= right) return;
  element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
})();"#;

#[derive(Clone, Copy, Debug)]
struct PendingFocusedEditableReveal {
    command_id: u64,
    sent_at: Instant,
}

fn pending_focused_editable_reveal(
    previous: Viewport,
    next: Viewport,
    command_id: u64,
    now: Instant,
) -> Option<PendingFocusedEditableReveal> {
    (next.height < previous.height || next.width < previous.width).then_some(
        PendingFocusedEditableReveal {
            command_id,
            sent_at: now,
        },
    )
}

fn take_successful_resize_ack(
    pending: &mut Option<PendingFocusedEditableReveal>,
    message: &TungMessage,
    now: Instant,
) -> Option<PendingFocusedEditableReveal> {
    let expected = (*pending)?;
    if now.saturating_duration_since(expected.sent_at) >= FOCUSED_EDITABLE_REVEAL_TIMEOUT {
        *pending = None;
        return None;
    }
    let bytes = match message {
        TungMessage::Text(text) => text.as_bytes(),
        TungMessage::Binary(bytes) => bytes.as_slice(),
        _ => return None,
    };
    if bytes.len() > RESIZE_ACK_MAX_BYTES {
        return None;
    }
    let response = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    if response.get("id").and_then(serde_json::Value::as_u64) != Some(expected.command_id) {
        return None;
    }
    *pending = None;
    (response.get("error").is_none()
        && response
            .get("result")
            .is_some_and(serde_json::Value::is_object))
    .then_some(expected)
}

fn may_reveal_focused_editable(
    pending: PendingFocusedEditableReveal,
    has_human_control: bool,
    expires_at: SystemTime,
    now: SystemTime,
    monotonic_now: Instant,
) -> bool {
    has_human_control
        && expires_at > now
        && monotonic_now.saturating_duration_since(pending.sent_at)
            < FOCUSED_EDITABLE_REVEAL_TIMEOUT
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InputAuthorityDecision {
    Dispatch,
    Reject,
    Close,
}

fn input_authority_decision(
    has_human_control: bool,
    rejected_input_rate_limit: &mut InputRateLimit,
) -> InputAuthorityDecision {
    if has_human_control {
        rejected_input_rate_limit.reset();
        InputAuthorityDecision::Dispatch
    } else if rejected_input_rate_limit.take() {
        InputAuthorityDecision::Reject
    } else {
        InputAuthorityDecision::Close
    }
}

fn input_expiry_delay(expires_at: SystemTime, now: SystemTime) -> Duration {
    expires_at.duration_since(now).unwrap_or(Duration::ZERO)
}

pub(super) async fn bridge_input(
    mut socket: WebSocket,
    target: ResolvedTarget,
    mut viewport: Viewport,
    expires_at: SystemTime,
    state: AppState,
    claims: OriginClaims,
    _input_admission: InputStreamAdmission,
) {
    let expiry_timer = sleep(input_expiry_delay(expires_at, SystemTime::now()));
    tokio::pin!(expiry_timer);
    let (mut cdp, _) = match connect_async(&target.websocket_url).await {
        Ok(connection) => connection,
        Err(error) => {
            warn!(?error, page_id = %target.id, "failed to connect remote browser input target");
            let _ = socket
                .send(WsMessage::Text(
                    json!({
                        "type": "error",
                        "message": "Unable to connect browser input.",
                        "fatal": true,
                    })
                    .to_string(),
                ))
                .await;
            let _ = socket.close().await;
            return;
        }
    };

    let mut next_command_id = 1u64;
    if state.browser_collaboration.has_human_control(&claims).await {
        if let Err(error) = send_cdp_command_and_wait(
            &mut cdp,
            next_command_id,
            "Emulation.setDeviceMetricsOverride",
            viewport.device_metrics_params(),
        )
        .await
        {
            let _ = socket
                .send(WsMessage::Text(
                    json!({ "type": "error", "message": error.to_string(), "fatal": true })
                        .to_string(),
                ))
                .await;
            let _ = socket.close().await;
            return;
        }
        next_command_id += 1;
    }

    if expires_at <= SystemTime::now() {
        let _ = cdp.send(TungMessage::Close(None)).await;
        let _ = socket.close().await;
        return;
    }

    let (mut client_sender, mut client_receiver) = socket.split();
    let (mut cdp_sender, mut cdp_receiver) = cdp.split();
    if !send_client_json(
        &mut client_sender,
        json!({
            "type": "ready",
            "pageId": target.id,
            "width": viewport.width,
            "height": viewport.height,
            "dpr": viewport.dpr,
            "deviceWidth": viewport.device_width(),
            "deviceHeight": viewport.device_height(),
        }),
    )
    .await
    {
        return;
    }

    let mut input_rate_limit = InputRateLimit::new();
    let mut rejected_input_rate_limit =
        InputRateLimit::with_limit(REVOKED_INPUT_MESSAGES_PER_SECOND, Duration::from_secs(1));
    let mut pending_focus_reveal = None;
    loop {
        tokio::select! {
            biased;
            _ = &mut expiry_timer => {
                break;
            }
            client_message = client_receiver.next() => {
                let Some(message_result) = client_message else {
                    break;
                };
                let message = match message_result {
                    Ok(message) => message,
                    Err(error) => {
                        warn!(?error, "remote browser input websocket receive failed");
                        break;
                    }
                };
                // Count every client frame before parsing or consulting the
                // live control owner. A former driver therefore cannot bypass
                // the ingress budget by sending invalid, ping, or rejected
                // input frames that never reach CDP dispatch.
                if !input_rate_limit.take() {
                    warn!("remote browser input websocket exceeded its ingress rate limit");
                    break;
                }
                match message {
                    WsMessage::Text(text) => {
                        let input = match ClientMessage::parse(&text) {
                            Ok(input) => input,
                            Err(error) => {
                                if !send_client_json(&mut client_sender, json!({
                                    "type": "error", "message": error.to_string(), "fatal": false,
                                })).await {
                                    break;
                                }
                                continue;
                            }
                        };
                        if input.acknowledged_frame_id().is_some() {
                            continue;
                        }
                        match input_authority_decision(
                            state.browser_collaboration.has_human_control(&claims).await,
                            &mut rejected_input_rate_limit,
                        ) {
                            InputAuthorityDecision::Dispatch => {}
                            InputAuthorityDecision::Reject => {
                                if !send_client_json(&mut client_sender, json!({
                                    "type": "error",
                                    "message": "Shared Browser input is controlled by another participant.",
                                    "fatal": false,
                                })).await {
                                    break;
                                }
                                continue;
                            }
                            InputAuthorityDecision::Close => {
                                warn!(
                                    "remote browser input websocket closed after a revoked-driver burst"
                                );
                                let _ = send_client_json(&mut client_sender, json!({
                                    "type": "error",
                                    "message": "Shared Browser input authority changed.",
                                    "fatal": true,
                                })).await;
                                break;
                            }
                        }
                        let next_viewport = match input.viewport() {
                            Ok(viewport) => viewport,
                            Err(error) => {
                                if !send_client_json(&mut client_sender, json!({
                                    "type": "error", "message": error.to_string(), "fatal": false,
                                })).await {
                                    break;
                                }
                                continue;
                            }
                        };
                        let command = match input.to_cdp_command(next_viewport.unwrap_or(viewport)) {
                            Ok(command) => command,
                            Err(error) => {
                                if !send_client_json(&mut client_sender, json!({
                                    "type": "error", "message": error.to_string(), "fatal": false,
                                })).await {
                                    break;
                                }
                                continue;
                            }
                        };
                        let Some((method, params)) = command else {
                            continue;
                        };
                        let command_id = next_command_id;
                        if cdp_sender.send(cdp_command(command_id, method, params)).await.is_err() {
                            break;
                        }
                        next_command_id = next_command_id.saturating_add(1);
                        if let Some(next_viewport) = next_viewport {
                            // Every newer resize supersedes an older pending
                            // reveal, including growth and DPR-only changes.
                            pending_focus_reveal = pending_focused_editable_reveal(
                                viewport, next_viewport, command_id, Instant::now(),
                            );
                            viewport = next_viewport;
                            if !send_client_json(&mut client_sender, viewport.ready_message("viewport")).await {
                                break;
                            }
                        }
                    }
                    WsMessage::Ping(payload) => {
                        if client_sender.send(WsMessage::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    WsMessage::Pong(_) => {}
                    WsMessage::Close(_) => break,
                    WsMessage::Binary(_) => {
                        if !send_client_json(&mut client_sender, json!({
                            "type": "error",
                            "message": "Binary browser input is not supported.",
                            "fatal": false,
                        })).await {
                            break;
                        }
                    }
                }
            }
            cdp_message = cdp_receiver.next() => {
                let Some(message_result) = cdp_message else {
                    break;
                };
                match message_result {
                    Ok(TungMessage::Ping(payload)) => {
                        if cdp_sender.send(TungMessage::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(TungMessage::Close(_)) | Err(_) => break,
                    Ok(message) => {
                        if let Some(pending) = take_successful_resize_ack(
                            &mut pending_focus_reveal, &message, Instant::now(),
                        ) {
                            // The resize response guarantees the metrics have
                            // applied; the fixed script's geometry read flushes
                            // layout synchronously. Reauthorize this extra CDP
                            // mutation after that asynchronous round trip.
                            if expires_at <= SystemTime::now() {
                                break;
                            }
                            let has_human_control =
                                state.browser_collaboration.has_human_control(&claims).await;
                            if may_reveal_focused_editable(
                                pending, has_human_control, expires_at,
                                SystemTime::now(), Instant::now(),
                            ) {
                                if cdp_sender.send(cdp_command(
                                    next_command_id,
                                    "Runtime.evaluate",
                                    json!({
                                        "expression": REVEAL_FOCUSED_EDITABLE_SCRIPT,
                                        "silent": true,
                                        "returnByValue": true,
                                        "awaitPromise": false,
                                        "userGesture": false,
                                        "timeout": 100,
                                    }),
                                )).await.is_err() {
                                    break;
                                }
                                next_command_id = next_command_id.saturating_add(1);
                            }
                        }
                    }
                }
            }
        }
    }

    let _ = cdp_sender.send(TungMessage::Close(None)).await;
    let _ = client_sender.send(WsMessage::Close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewport(width: u32, height: u32, dpr: f64) -> Viewport {
        Viewport::new(width, height, dpr).expect("valid test viewport")
    }

    #[test]
    fn focused_editable_reveal_is_only_scheduled_for_a_logical_shrink() {
        let now = Instant::now();
        let previous = viewport(800, 600, 1.0);
        for next in [viewport(800, 320, 1.0), viewport(600, 600, 1.0)] {
            assert!(pending_focused_editable_reveal(previous, next, 4, now).is_some());
        }
        for next in [previous, viewport(900, 700, 1.0), viewport(800, 600, 2.0)] {
            assert!(pending_focused_editable_reveal(previous, next, 4, now).is_none());
        }
    }

    #[test]
    fn focused_editable_reveal_waits_for_matching_success_and_consumes_it_once() {
        let now = Instant::now();
        let mut pending = pending_focused_editable_reveal(
            viewport(800, 600, 1.0),
            viewport(800, 320, 1.0),
            7,
            now,
        );
        for message in [
            TungMessage::Text(r#"{"id":6,"result":{}}"#.into()),
            TungMessage::Text(r#"{"method":"Page.frameResized","params":{}}"#.into()),
            TungMessage::Text("not JSON".into()),
            TungMessage::Ping(Vec::new()),
        ] {
            assert!(take_successful_resize_ack(&mut pending, &message, now).is_none());
            assert!(pending.is_some());
        }
        let success = TungMessage::Text(r#"{"id":7,"result":{}}"#.into());
        assert!(take_successful_resize_ack(&mut pending, &success, now).is_some());
        assert!(pending.is_none());
        assert!(take_successful_resize_ack(&mut pending, &success, now).is_none());
    }

    #[test]
    fn failed_or_incomplete_resize_ack_never_reveals_and_is_not_retried() {
        let now = Instant::now();
        for response in [
            r#"{"id":7,"error":{"message":"rejected"}}"#,
            r#"{"id":7,"result":{},"error":{"message":"rejected"}}"#,
            r#"{"id":7}"#,
            r#"{"id":7,"result":null}"#,
        ] {
            let mut pending = pending_focused_editable_reveal(
                viewport(800, 600, 1.0),
                viewport(800, 320, 1.0),
                7,
                now,
            );
            assert!(take_successful_resize_ack(
                &mut pending,
                &TungMessage::Text(response.into()),
                now,
            )
            .is_none());
            assert!(pending.is_none());
            assert!(take_successful_resize_ack(
                &mut pending,
                &TungMessage::Text(r#"{"id":7,"result":{}}"#.into()),
                now,
            )
            .is_none());
        }
    }

    #[test]
    fn newer_resize_supersedes_pending_reveal_including_growth() {
        let now = Instant::now();
        let original = viewport(800, 600, 1.0);
        let first = viewport(800, 400, 1.0);
        let second = viewport(800, 300, 1.0);
        let mut pending = pending_focused_editable_reveal(original, first, 10, now);
        assert!(pending.is_some());
        pending = pending_focused_editable_reveal(first, second, 11, now);
        assert!(take_successful_resize_ack(
            &mut pending,
            &TungMessage::Text(r#"{"id":10,"result":{}}"#.into()),
            now,
        )
        .is_none());
        assert_eq!(pending.expect("newer shrink still pending").command_id, 11);
        pending = pending_focused_editable_reveal(second, original, 12, now);
        assert!(pending.is_none());
        assert!(take_successful_resize_ack(
            &mut pending,
            &TungMessage::Text(r#"{"id":11,"result":{}}"#.into()),
            now,
        )
        .is_none());
    }

    #[test]
    fn resize_ack_is_bounded_and_late_responses_cannot_reveal() {
        let now = Instant::now();
        let make_pending = || {
            pending_focused_editable_reveal(
                viewport(800, 600, 1.0),
                viewport(800, 320, 1.0),
                7,
                now,
            )
        };
        let success = TungMessage::Binary(br#"{"id":7,"result":{}}"#.to_vec());
        assert!(take_successful_resize_ack(&mut make_pending(), &success, now).is_some());

        let mut pending = make_pending();
        assert!(take_successful_resize_ack(
            &mut pending,
            &TungMessage::Text(" ".repeat(RESIZE_ACK_MAX_BYTES + 1)),
            now,
        )
        .is_none());
        assert!(pending.is_some());
        assert!(take_successful_resize_ack(
            &mut pending,
            &success,
            now + FOCUSED_EDITABLE_REVEAL_TIMEOUT,
        )
        .is_none());
        assert!(pending.is_none());
    }

    #[test]
    fn focused_editable_reveal_requires_fresh_authority_and_unexpired_deadlines() {
        let monotonic_now = Instant::now();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let pending = pending_focused_editable_reveal(
            viewport(800, 600, 1.0),
            viewport(800, 320, 1.0),
            7,
            monotonic_now,
        )
        .expect("shrinking viewport");
        assert!(may_reveal_focused_editable(
            pending,
            true,
            now + Duration::from_secs(30),
            now,
            monotonic_now,
        ));
        assert!(!may_reveal_focused_editable(
            pending,
            false,
            now + Duration::from_secs(30),
            now,
            monotonic_now,
        ));
        assert!(!may_reveal_focused_editable(
            pending,
            true,
            now,
            now,
            monotonic_now,
        ));
        assert!(!may_reveal_focused_editable(
            pending,
            true,
            now - Duration::from_secs(1),
            now,
            monotonic_now,
        ));
        assert!(!may_reveal_focused_editable(
            pending,
            true,
            now + Duration::from_secs(30),
            now,
            monotonic_now + FOCUSED_EDITABLE_REVEAL_TIMEOUT,
        ));
    }

    #[test]
    fn focused_editable_script_is_fixed_synchronous_and_value_free() {
        for disallowed in [
            ".focus(",
            ".blur(",
            ".value",
            ".textContent",
            ".innerHTML",
            "clipboard",
            "requestAnimationFrame",
            "setTimeout",
            "Promise",
            "contentDocument",
            "contentWindow",
        ] {
            assert!(
                !REVEAL_FOCUSED_EDITABLE_SCRIPT.contains(disallowed),
                "{disallowed}"
            );
        }
        assert!(REVEAL_FOCUSED_EDITABLE_SCRIPT.contains("document.activeElement"));
        assert!(REVEAL_FOCUSED_EDITABLE_SCRIPT.contains("behavior: 'instant'"));
        assert!(REVEAL_FOCUSED_EDITABLE_SCRIPT.contains("block: 'nearest'"));
    }

    #[test]
    fn input_expiry_delay_uses_the_signed_absolute_deadline() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        assert_eq!(
            input_expiry_delay(now + Duration::from_millis(250), now),
            Duration::from_millis(250)
        );
        assert_eq!(
            input_expiry_delay(now - Duration::from_millis(1), now),
            Duration::ZERO
        );
    }

    #[test]
    fn revoked_driver_burst_is_closed_after_bounded_authority_checks() {
        let mut rejected =
            InputRateLimit::with_limit(REVOKED_INPUT_MESSAGES_PER_SECOND, Duration::from_secs(1));
        for _ in 0..REVOKED_INPUT_MESSAGES_PER_SECOND {
            assert_eq!(
                input_authority_decision(false, &mut rejected),
                InputAuthorityDecision::Reject
            );
        }
        assert_eq!(
            input_authority_decision(false, &mut rejected),
            InputAuthorityDecision::Close
        );

        assert_eq!(
            input_authority_decision(true, &mut rejected),
            InputAuthorityDecision::Dispatch
        );
        assert_eq!(
            input_authority_decision(false, &mut rejected),
            InputAuthorityDecision::Reject,
            "an authorized dispatch resets the revoked-driver budget"
        );
    }
}
