use std::time::{Duration, SystemTime};

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
                        if cdp_sender.send(cdp_command(next_command_id, method, params)).await.is_err() {
                            break;
                        }
                        next_command_id = next_command_id.saturating_add(1);
                        if let Some(next_viewport) = next_viewport {
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
                    Ok(_) => {}
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
