use std::time::{Duration, Instant, SystemTime};

use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde_json::{json, Value as JsonValue};
use tokio::time::{interval, sleep, MissedTickBehavior};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as TungMessage;
use tracing::{debug, info, warn};

use crate::browser_collaboration::PixelStreamAdmission;

use super::protocol::{
    parse_screencast_frame, ClientMessage, ScreencastFrame, Viewport, FRAME_DATA_MAX_BYTES,
};
use super::transport::{cdp_command, send_cdp_command_and_wait, send_client_json, ResolvedTarget};

const FRAME_ACK_TIMEOUT: Duration = Duration::from_secs(5);
const FRAME_ACK_CHECK_INTERVAL: Duration = Duration::from_millis(500);
const SCREENCAST_MAX_DIMENSION: u32 = 4096;
const SCREENCAST_JPEG_QUALITY: u8 = 85;
const BOOTSTRAP_FRAME_ID: u64 = 1;

fn viewer_expiry_delay(expires_at: SystemTime, now: SystemTime) -> Duration {
    expires_at.duration_since(now).unwrap_or(Duration::ZERO)
}

#[derive(Debug)]
struct PendingFrame {
    frame_id: u64,
    cdp_session_id: i64,
    jpeg_bytes: usize,
    sent_at: Instant,
}

#[derive(Debug)]
struct QueuedFrame {
    frame: ScreencastFrame,
    received_at: Instant,
}

#[derive(Debug)]
struct ClientFrame {
    frame_id: u64,
    frame: ScreencastFrame,
}

#[derive(Debug)]
enum IncomingFrameAction {
    Deliver(ClientFrame),
    Buffer {
        superseded: Option<FrameMeasurement>,
    },
}

#[derive(Debug)]
struct CompletedFrame {
    cdp_session_id: i64,
    next_frame: Option<ClientFrame>,
    measurement: FrameMeasurement,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FrameOutcome {
    Acknowledged,
    TimedOut,
    Superseded,
}

impl FrameOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Acknowledged => "acknowledged",
            Self::TimedOut => "timed_out",
            Self::Superseded => "superseded",
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
struct FrameMeasurement {
    frame_id: Option<u64>,
    cdp_session_id: i64,
    jpeg_bytes: usize,
    duration: Duration,
    outcome: FrameOutcome,
}

/// Bounds renderer backpressure to one client-visible frame plus the newest
/// frame Chromium produced while that frame was awaiting acknowledgement.
///
/// Chromium can emit the only detailed navigation frame before an earlier
/// about:blank frame's acknowledgement has crossed the controller/tunnel. If
/// that newer frame is acknowledged and discarded, the client can remain on a
/// white canvas forever. Preserve the newest frame and promote it as soon as
/// the pending frame completes instead.
#[derive(Debug)]
struct FrameBackpressure {
    pending: Option<PendingFrame>,
    queued_latest: Option<QueuedFrame>,
    next_frame_id: u64,
}

impl Default for FrameBackpressure {
    fn default() -> Self {
        Self {
            pending: None,
            queued_latest: None,
            next_frame_id: 1,
        }
    }
}

impl FrameBackpressure {
    fn accept(&mut self, frame: ScreencastFrame, now: Instant) -> IncomingFrameAction {
        if self.pending.is_none() {
            return IncomingFrameAction::Deliver(self.promote(frame, now));
        }

        let superseded = self
            .queued_latest
            .replace(QueuedFrame {
                frame,
                received_at: now,
            })
            .map(|queued| FrameMeasurement {
                frame_id: None,
                cdp_session_id: queued.frame.session_id,
                jpeg_bytes: encoded_jpeg_bytes(&queued.frame.data),
                duration: now.saturating_duration_since(queued.received_at),
                outcome: FrameOutcome::Superseded,
            });
        IncomingFrameAction::Buffer { superseded }
    }

    fn acknowledge(&mut self, frame_id: u64, now: Instant) -> Option<CompletedFrame> {
        if self.pending.as_ref().map(|frame| frame.frame_id) != Some(frame_id) {
            return None;
        }
        self.complete_pending(now, FrameOutcome::Acknowledged)
    }

    fn expire(&mut self, now: Instant, timeout: Duration) -> Option<CompletedFrame> {
        let pending = self.pending.as_ref()?;
        if now.saturating_duration_since(pending.sent_at) < timeout {
            return None;
        }
        self.complete_pending(now, FrameOutcome::TimedOut)
    }

    fn complete_pending(&mut self, now: Instant, outcome: FrameOutcome) -> Option<CompletedFrame> {
        let completed = self.pending.take()?;
        let next_frame = self
            .queued_latest
            .take()
            .map(|queued| self.promote(queued.frame, now));
        Some(CompletedFrame {
            cdp_session_id: completed.cdp_session_id,
            next_frame,
            measurement: FrameMeasurement {
                frame_id: Some(completed.frame_id),
                cdp_session_id: completed.cdp_session_id,
                jpeg_bytes: completed.jpeg_bytes,
                duration: now.saturating_duration_since(completed.sent_at),
                outcome,
            },
        })
    }

    fn promote(&mut self, frame: ScreencastFrame, now: Instant) -> ClientFrame {
        let frame_id = self.next_frame_id;
        self.next_frame_id = self
            .next_frame_id
            .checked_add(1)
            .expect("screencast frame id exhausted");
        self.pending = Some(PendingFrame {
            frame_id,
            cdp_session_id: frame.session_id,
            jpeg_bytes: encoded_jpeg_bytes(&frame.data),
            sent_at: now,
        });
        ClientFrame { frame_id, frame }
    }
}

fn encoded_jpeg_bytes(data: &str) -> usize {
    let unpadded_len = data.trim_end_matches('=').len();
    (unpadded_len / 4)
        .saturating_mul(3)
        .saturating_add(match unpadded_len % 4 {
            2 => 1,
            3 => 2,
            _ => 0,
        })
}

fn bounded_capture_screenshot_data(result: &JsonValue) -> Option<String> {
    let data = result.get("data")?.as_str()?.trim();
    if data.is_empty() || encoded_jpeg_bytes(data) > FRAME_DATA_MAX_BYTES {
        return None;
    }
    Some(data.to_string())
}

fn log_frame_measurement(page_id: &str, measurement: &FrameMeasurement) {
    let duration_ms = measurement
        .duration
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    let client_visible = measurement.frame_id.is_some();
    let frame_id = measurement.frame_id.unwrap_or_default();
    match measurement.outcome {
        FrameOutcome::TimedOut => info!(
            transport = "cdp-screencast",
            outcome = measurement.outcome.as_str(),
            jpeg_bytes = measurement.jpeg_bytes,
            duration_ms,
            page_id,
            client_visible,
            frame_id,
            cdp_session_id = measurement.cdp_session_id,
            "shared browser CDP frame completed"
        ),
        FrameOutcome::Acknowledged | FrameOutcome::Superseded => debug!(
            transport = "cdp-screencast",
            outcome = measurement.outcome.as_str(),
            jpeg_bytes = measurement.jpeg_bytes,
            duration_ms,
            page_id,
            client_visible,
            frame_id,
            cdp_session_id = measurement.cdp_session_id,
            "shared browser CDP frame completed"
        ),
    }
}

async fn send_screencast_frame(
    client_sender: &mut SplitSink<WebSocket, WsMessage>,
    frame: &ClientFrame,
) -> bool {
    send_client_json(client_sender, client_frame_message(frame)).await
}

fn client_frame_message(frame: &ClientFrame) -> JsonValue {
    json!({
        "type": "frame",
        "frameId": frame.frame_id,
        "data": frame.frame.data,
        "metadata": frame.frame.metadata,
    })
}

pub(super) async fn bridge_screencast(
    mut socket: WebSocket,
    target: ResolvedTarget,
    viewport: Viewport,
    expires_at: SystemTime,
    _pixel_admission: PixelStreamAdmission,
) {
    // Start the absolute-lifetime timer before any asynchronous CDP setup so
    // setup time can never extend the signed viewing window.
    let expiry_timer = sleep(viewer_expiry_delay(expires_at, SystemTime::now()));
    tokio::pin!(expiry_timer);
    let (mut cdp, _) = match connect_async(&target.websocket_url).await {
        Ok(connection) => connection,
        Err(error) => {
            let _ = socket
                .send(WsMessage::Text(
                    json!({
                        "type": "error",
                        "message": "Unable to connect to the browser renderer.",
                        "fatal": true,
                    })
                    .to_string(),
                ))
                .await;
            warn!(?error, page_id = %target.id, "failed to connect CDP screencast target");
            let _ = socket.close().await;
            return;
        }
    };

    let mut next_command_id = 1u64;
    if let Err(error) =
        send_cdp_command_and_wait(&mut cdp, next_command_id, "Page.enable", json!({})).await
    {
        let _ = socket
            .send(WsMessage::Text(
                json!({ "type": "error", "message": error.to_string(), "fatal": true }).to_string(),
            ))
            .await;
        let _ = socket.close().await;
        return;
    }
    next_command_id += 1;
    // Chromium does not reliably emit an initial screencastFrame to a second
    // CDP viewer when another viewer is already streaming the same page. Take
    // one bounded point-in-time frame before starting the event stream so every
    // newly joined teammate has pixels immediately. It is origin-generated and
    // does not require a Chromium screencastFrameAck.
    let bootstrap_frame = match send_cdp_command_and_wait(
        &mut cdp,
        next_command_id,
        "Page.captureScreenshot",
        json!({
            "format": "jpeg",
            "quality": SCREENCAST_JPEG_QUALITY,
            "fromSurface": true,
            "captureBeyondViewport": false,
        }),
    )
    .await
    {
        Ok(result) => bounded_capture_screenshot_data(&result),
        Err(error) => {
            warn!(?error, page_id = %target.id, "failed to capture initial CDP viewer frame");
            None
        }
    };
    next_command_id += 1;
    let start_command_id = next_command_id;
    if let Err(error) = cdp
        .send(cdp_command(
            start_command_id,
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": SCREENCAST_JPEG_QUALITY,
                "maxWidth": SCREENCAST_MAX_DIMENSION,
                "maxHeight": SCREENCAST_MAX_DIMENSION,
                "everyNthFrame": 1,
            }),
        ))
        .await
    {
        let _ = socket
            .send(WsMessage::Text(
                json!({
                    "type": "error",
                    "message": "Unable to start the browser renderer.",
                    "fatal": true,
                })
                .to_string(),
            ))
            .await;
        warn!(?error, page_id = %target.id, "failed to start CDP screencast");
        let _ = socket.close().await;
        return;
    }
    next_command_id += 1;

    // The token may have expired during target connection/Page setup. Do not
    // emit `ready` (or any pixels) in that case.
    if expires_at <= SystemTime::now() {
        let _ = cdp
            .send(cdp_command(
                next_command_id,
                "Page.stopScreencast",
                json!({}),
            ))
            .await;
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

    if let Some(data) = bootstrap_frame {
        if !send_client_json(
            &mut client_sender,
            json!({
                "type": "frame",
                "frameId": BOOTSTRAP_FRAME_ID,
                "data": data,
                "metadata": { "bootstrap": true },
            }),
        )
        .await
        {
            return;
        }
    }

    let mut frame_backpressure = FrameBackpressure {
        next_frame_id: BOOTSTRAP_FRAME_ID + 1,
        ..FrameBackpressure::default()
    };
    let mut ack_timer = interval(FRAME_ACK_CHECK_INTERVAL);
    ack_timer.set_missed_tick_behavior(MissedTickBehavior::Skip);

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
                        warn!(?error, "CDP screencast client websocket receive failed");
                        break;
                    }
                };
                match message {
                    WsMessage::Text(text) => {
                        let input = match ClientMessage::parse(&text) {
                            Ok(input) => input,
                            Err(error) => {
                                if !send_client_json(&mut client_sender, json!({
                                    "type": "error",
                                    "message": error.to_string(),
                                    "fatal": false,
                                })).await {
                                    break;
                                }
                                continue;
                            }
                        };

                        if let Some(frame_id) = input.acknowledged_frame_id() {
                            let Some(completed) = frame_backpressure
                                .acknowledge(frame_id, Instant::now())
                            else {
                                continue;
                            };
                            log_frame_measurement(&target.id, &completed.measurement);
                            if cdp_sender
                                .send(cdp_command(
                                    next_command_id,
                                    "Page.screencastFrameAck",
                                    json!({ "sessionId": completed.cdp_session_id }),
                                ))
                                .await
                                .is_err()
                            {
                                break;
                            }
                            next_command_id = next_command_id.saturating_add(1);
                            if let Some(next_frame) = completed.next_frame.as_ref() {
                                if !send_screencast_frame(&mut client_sender, next_frame).await {
                                    break;
                                }
                            }
                            continue;
                        }

                        if !send_client_json(&mut client_sender, json!({
                            "type": "error",
                            "message": "Shared Browser renderer is view-only; use the input channel.",
                            "fatal": false,
                        })).await {
                            break;
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
                let message = match message_result {
                    Ok(message) => message,
                    Err(error) => {
                        warn!(?error, "CDP screencast websocket receive failed");
                        break;
                    }
                };
                let payload = match message {
                    TungMessage::Text(text) => serde_json::from_str::<JsonValue>(&text).ok(),
                    TungMessage::Binary(bytes) => serde_json::from_slice::<JsonValue>(&bytes).ok(),
                    TungMessage::Ping(payload) => {
                        if cdp_sender.send(TungMessage::Pong(payload)).await.is_err() {
                            break;
                        }
                        None
                    }
                    TungMessage::Close(_) => break,
                    _ => None,
                };
                let Some(payload) = payload else {
                    continue;
                };

                if payload.get("id").and_then(JsonValue::as_u64) == Some(start_command_id) {
                    if payload.get("error").is_some() {
                        let _ = send_client_json(&mut client_sender, json!({
                            "type": "error",
                            "message": "The browser rejected screencast startup.",
                            "fatal": true,
                        })).await;
                        break;
                    }
                    continue;
                }

                match parse_screencast_frame(&payload) {
                    Ok(Some(frame)) => match frame_backpressure.accept(frame, Instant::now()) {
                        IncomingFrameAction::Deliver(frame) => {
                            if !send_screencast_frame(&mut client_sender, &frame).await {
                                break;
                            }
                        }
                        IncomingFrameAction::Buffer {
                            superseded: Some(measurement),
                        } => {
                            log_frame_measurement(&target.id, &measurement);
                            if cdp_sender.send(cdp_command(
                                next_command_id,
                                "Page.screencastFrameAck",
                                json!({ "sessionId": measurement.cdp_session_id }),
                            )).await.is_err() {
                                break;
                            }
                            next_command_id = next_command_id.saturating_add(1);
                        }
                        IncomingFrameAction::Buffer {
                            superseded: None,
                        } => {}
                    },
                    Ok(None) => {}
                    Err(error) => {
                        if let Some(session_id) = payload
                            .get("params")
                            .and_then(|params| params.get("sessionId"))
                            .and_then(JsonValue::as_i64)
                        {
                            let _ = cdp_sender.send(cdp_command(
                                next_command_id,
                                "Page.screencastFrameAck",
                                json!({ "sessionId": session_id }),
                            )).await;
                            next_command_id = next_command_id.saturating_add(1);
                        }
                        if !send_client_json(&mut client_sender, json!({
                            "type": "error",
                            "message": error.to_string(),
                            "fatal": false,
                        })).await {
                            break;
                        }
                    }
                }
            }
            _ = ack_timer.tick() => {
                let Some(completed) = frame_backpressure
                    .expire(Instant::now(), FRAME_ACK_TIMEOUT)
                else {
                    continue;
                };
                log_frame_measurement(&target.id, &completed.measurement);
                if cdp_sender.send(cdp_command(
                    next_command_id,
                    "Page.screencastFrameAck",
                    json!({ "sessionId": completed.cdp_session_id }),
                )).await.is_err() {
                    break;
                }
                next_command_id = next_command_id.saturating_add(1);
                if let Some(next_frame) = completed.next_frame.as_ref() {
                    if !send_screencast_frame(&mut client_sender, next_frame).await {
                        break;
                    }
                }
            }
        }
    }

    let _ = cdp_sender
        .send(cdp_command(
            next_command_id,
            "Page.stopScreencast",
            json!({}),
        ))
        .await;
    let _ = cdp_sender.send(TungMessage::Close(None)).await;
    let _ = client_sender.send(WsMessage::Close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(session_id: i64, label: &str) -> ScreencastFrame {
        ScreencastFrame {
            session_id,
            data: label.to_string(),
            metadata: json!({}),
        }
    }

    #[test]
    fn viewer_expiry_delay_uses_the_absolute_signed_deadline() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        assert_eq!(
            viewer_expiry_delay(now + Duration::from_millis(250), now),
            Duration::from_millis(250)
        );
        assert_eq!(
            viewer_expiry_delay(now - Duration::from_millis(1), now),
            Duration::ZERO
        );
    }

    #[test]
    fn delayed_ack_promotes_the_navigation_frame() {
        let now = Instant::now();
        let mut backpressure = FrameBackpressure::default();

        assert!(matches!(
            backpressure.accept(frame(41, "initial"), now),
            IncomingFrameAction::Deliver(ClientFrame {
                frame_id: 1,
                frame: ScreencastFrame { session_id: 41, .. },
            })
        ));
        assert!(matches!(
            backpressure.accept(frame(42, "navigation"), now + Duration::from_millis(1)),
            IncomingFrameAction::Buffer { superseded: None }
        ));

        assert!(backpressure
            .acknowledge(99, now + Duration::from_millis(2))
            .is_none());
        let completed = backpressure
            .acknowledge(1, now + Duration::from_millis(3))
            .expect("pending frame completes");
        assert_eq!(completed.cdp_session_id, 41);
        assert_eq!(completed.measurement.outcome, FrameOutcome::Acknowledged);
        assert_eq!(completed.measurement.duration, Duration::from_millis(3));
        assert_eq!(
            completed
                .next_frame
                .as_ref()
                .map(|frame| (frame.frame_id, frame.frame.session_id)),
            Some((2, 42))
        );
        assert_eq!(
            backpressure
                .pending
                .as_ref()
                .map(|frame| (frame.frame_id, frame.cdp_session_id)),
            Some((2, 42))
        );

        let final_completion = backpressure
            .acknowledge(2, now + Duration::from_millis(4))
            .expect("promoted frame completes independently");
        assert_eq!(final_completion.cdp_session_id, 42);
        assert!(final_completion.next_frame.is_none());
        assert!(backpressure.pending.is_none());
    }

    #[test]
    fn client_frame_protocol_keeps_the_cdp_session_id_internal() {
        let payload = client_frame_message(&ClientFrame {
            frame_id: 7,
            frame: frame(41, "jpeg"),
        });

        assert_eq!(payload["frameId"], 7);
        assert_eq!(payload["data"], "jpeg");
        assert!(payload.get("sessionId").is_none());
    }

    #[test]
    fn initial_capture_is_bounded_before_it_becomes_a_client_frame() {
        assert_eq!(
            bounded_capture_screenshot_data(&json!({ "data": "AQIDBA==" })).as_deref(),
            Some("AQIDBA==")
        );
        assert!(bounded_capture_screenshot_data(&json!({ "data": "" })).is_none());
        assert!(bounded_capture_screenshot_data(&json!({
            "data": "A".repeat((FRAME_DATA_MAX_BYTES / 3 + 1) * 4),
        }))
        .is_none());
    }

    #[test]
    fn queued_frames_coalesce_to_the_latest_frame() {
        let now = Instant::now();
        let mut backpressure = FrameBackpressure::default();
        let _ = backpressure.accept(frame(51, "initial"), now);
        let _ = backpressure.accept(frame(52, "AQIDBA=="), now + Duration::from_millis(1));

        assert!(matches!(
            backpressure.accept(frame(53, "latest"), now + Duration::from_millis(2)),
            IncomingFrameAction::Buffer {
                superseded: Some(FrameMeasurement {
                    frame_id: None,
                    cdp_session_id: 52,
                    jpeg_bytes: 4,
                    outcome: FrameOutcome::Superseded,
                    duration,
                })
            } if duration == Duration::from_millis(1)
        ));
        let completed = backpressure
            .acknowledge(1, now + Duration::from_millis(3))
            .expect("pending frame completes");
        assert_eq!(
            completed
                .next_frame
                .map(|frame| (frame.frame_id, frame.frame.session_id)),
            Some((2, 53))
        );
    }

    #[test]
    fn frame_measurements_report_jpeg_bytes_and_terminal_outcomes() {
        let now = Instant::now();
        let mut acknowledged = FrameBackpressure::default();
        let _ = acknowledged.accept(frame(61, "AQIDBA=="), now);
        let completed = acknowledged
            .acknowledge(1, now + Duration::from_millis(125))
            .expect("frame acknowledged");
        assert_eq!(
            completed.measurement,
            FrameMeasurement {
                frame_id: Some(1),
                cdp_session_id: 61,
                jpeg_bytes: 4,
                duration: Duration::from_millis(125),
                outcome: FrameOutcome::Acknowledged,
            }
        );

        let mut timed_out = FrameBackpressure::default();
        let _ = timed_out.accept(frame(62, "AQID"), now);
        let completed = timed_out
            .expire(now + FRAME_ACK_TIMEOUT, FRAME_ACK_TIMEOUT)
            .expect("frame timed out");
        assert_eq!(
            completed.measurement,
            FrameMeasurement {
                frame_id: Some(1),
                cdp_session_id: 62,
                jpeg_bytes: 3,
                duration: FRAME_ACK_TIMEOUT,
                outcome: FrameOutcome::TimedOut,
            }
        );
    }

    #[test]
    fn stale_frame_id_cannot_ack_promoted_frame_with_the_same_cdp_session_id() {
        let now = Instant::now();
        let mut backpressure = FrameBackpressure::default();
        let _ = backpressure.accept(frame(1, "initial"), now);
        let _ = backpressure.accept(frame(1, "navigation"), now + Duration::from_millis(1));

        assert!(backpressure
            .expire(
                now + FRAME_ACK_TIMEOUT - Duration::from_millis(1),
                FRAME_ACK_TIMEOUT
            )
            .is_none());
        let completed = backpressure
            .expire(now + FRAME_ACK_TIMEOUT, FRAME_ACK_TIMEOUT)
            .expect("pending frame expires");
        assert_eq!(completed.cdp_session_id, 1);
        assert_eq!(completed.measurement.outcome, FrameOutcome::TimedOut);
        assert_eq!(completed.measurement.duration, FRAME_ACK_TIMEOUT);
        assert_eq!(
            completed.next_frame.as_ref().map(|frame| (
                frame.frame_id,
                frame.frame.session_id,
                frame.frame.data.as_str()
            )),
            Some((2, 1, "navigation"))
        );

        assert!(backpressure
            .expire(
                now + FRAME_ACK_TIMEOUT + Duration::from_millis(1),
                FRAME_ACK_TIMEOUT,
            )
            .is_none());

        // Chromium intentionally reuses one CDP session id for every frame in
        // a screencast session. A late client acknowledgement for the expired
        // frame must not complete the newly promoted frame with that same id.
        assert!(backpressure
            .acknowledge(1, now + FRAME_ACK_TIMEOUT + Duration::from_millis(2))
            .is_none());
        assert_eq!(
            backpressure
                .pending
                .as_ref()
                .map(|frame| (frame.frame_id, frame.cdp_session_id)),
            Some((2, 1))
        );

        let promoted = backpressure
            .acknowledge(2, now + FRAME_ACK_TIMEOUT + Duration::from_millis(3))
            .expect("the promoted transport frame id completes independently");
        assert_eq!(promoted.cdp_session_id, 1);
        assert!(promoted.next_frame.is_none());
    }
}
