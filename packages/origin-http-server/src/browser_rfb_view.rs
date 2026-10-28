//! The view-only RFB lane: the browser's pixels for a person who does not
//! drive it, such as while Octo holds the browser, with every input message
//! taken out on the way in.
//!
//! RFB carries pixels and raw input on one stream, so the driver's own lane
//! (`/browser/vnc`) stays driver-exclusive. This lane reads the client's half
//! of the protocol instead of passing it through: RFB 3.8 with no security
//! (what the runtime's Xtigervnc offers on loopback), a shared session, and
//! then only the messages that ask for pixels. Key and pointer events,
//! clipboard text, desktop resizes and power requests are dropped; anything
//! the lane does not know closes it. The server's half is passed through.
//!
//! The display shows the tab in front, and Octo brings the tab it works in
//! to the front, so a viewer on this lane follows Octo across its own tabs.

use std::time::{Duration, SystemTime};

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::Extension;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::warn;

use crate::auth::{validated_claim_expiry, OriginClaims};
use crate::browser_host::BrowserHostReady;
use crate::error::OriginError;
use crate::routes::AppState;

const RFB_VERSION_3_8: &[u8; 12] = b"RFB 003.008\n";
const SECURITY_NONE: u8 = 1;
const SHARED_SESSION: u8 = 1;
/// The most encodings a SetEncodings may name (noVNC sends about thirty).
const MAX_ENCODINGS: usize = 1_024;
/// The longest clipboard text a dropped ClientCutText may carry before the
/// lane closes instead of reading past it.
const MAX_DROPPED_CUT_TEXT_BYTES: u64 = 1 << 20;
/// A view-only client sends small messages; a frame larger than this closes
/// the lane before it is read.
const MAX_CLIENT_FRAME_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Stage {
    Version,
    Security,
    ClientInit,
    Messages,
}

/// What one client message is to the lane.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Verdict {
    /// Pixels and how they are sent: passed on.
    Forward(usize),
    /// Input or a change to the shared session: dropped. The second value is
    /// the length of a body still to come that is dropped as it arrives.
    Drop(usize, u64),
}

/// Reads the client's half of an RFB session and keeps only what a viewer
/// may send. Fed the WebSocket's bytes in order; returns the bytes to pass to
/// the RFB server, or why the lane closes.
#[derive(Debug)]
pub(crate) struct RfbViewOnlyFilter {
    stage: Stage,
    pending: Vec<u8>,
    /// Bytes of a dropped message's body still to come.
    skip: u64,
}

impl Default for RfbViewOnlyFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl RfbViewOnlyFilter {
    pub(crate) fn new() -> Self {
        Self {
            stage: Stage::Version,
            pending: Vec::new(),
            skip: 0,
        }
    }

    pub(crate) fn feed(&mut self, input: &[u8]) -> Result<Vec<u8>, &'static str> {
        self.pending.extend_from_slice(input);
        let mut forward = Vec::new();
        let mut at = 0;
        loop {
            if self.skip > 0 {
                let available = (self.pending.len() - at) as u64;
                let dropped = available.min(self.skip);
                at += dropped as usize;
                self.skip -= dropped;
                if self.skip > 0 {
                    break;
                }
            }
            let rest = &self.pending[at..];
            match self.stage {
                Stage::Version => {
                    if rest.len() < RFB_VERSION_3_8.len() {
                        if !RFB_VERSION_3_8.starts_with(rest) {
                            return Err("the viewer did not speak RFB 3.8");
                        }
                        break;
                    }
                    if &rest[..RFB_VERSION_3_8.len()] != RFB_VERSION_3_8 {
                        return Err("the viewer did not speak RFB 3.8");
                    }
                    forward.extend_from_slice(RFB_VERSION_3_8);
                    at += RFB_VERSION_3_8.len();
                    self.stage = Stage::Security;
                }
                Stage::Security => {
                    let Some(&kind) = rest.first() else { break };
                    if kind != SECURITY_NONE {
                        return Err("the viewer chose a security type this lane does not pass");
                    }
                    forward.push(kind);
                    at += 1;
                    self.stage = Stage::ClientInit;
                }
                Stage::ClientInit => {
                    if rest.is_empty() {
                        break;
                    }
                    // Always a shared session: a viewer never disconnects the
                    // person or the agent who drives.
                    forward.push(SHARED_SESSION);
                    at += 1;
                    self.stage = Stage::Messages;
                }
                Stage::Messages => {
                    if rest.is_empty() {
                        break;
                    }
                    match client_message(rest)? {
                        None => break,
                        Some(Verdict::Forward(length)) => {
                            forward.extend_from_slice(&rest[..length]);
                            at += length;
                        }
                        Some(Verdict::Drop(length, body)) => {
                            at += length;
                            self.skip = body;
                        }
                    }
                }
            }
        }
        self.pending.drain(..at);
        if self.pending.len() > MAX_CLIENT_FRAME_BYTES {
            return Err("the viewer sent an oversized message");
        }
        Ok(forward)
    }
}

/// The next client message's verdict, None while its header is incomplete.
fn client_message(bytes: &[u8]) -> Result<Option<Verdict>, &'static str> {
    let need = |length: usize| bytes.len() >= length;
    let verdict = match bytes[0] {
        // SetPixelFormat.
        0 => need(20).then_some(Verdict::Forward(20)),
        // SetEncodings: a count, then four bytes per encoding.
        2 => {
            if !need(4) {
                return Ok(None);
            }
            let count = usize::from(u16::from_be_bytes([bytes[2], bytes[3]]));
            if count > MAX_ENCODINGS {
                return Err("the viewer named too many encodings");
            }
            let length = 4 + 4 * count;
            need(length).then_some(Verdict::Forward(length))
        }
        // FramebufferUpdateRequest.
        3 => need(10).then_some(Verdict::Forward(10)),
        // KeyEvent.
        4 => need(8).then_some(Verdict::Drop(8, 0)),
        // PointerEvent.
        5 => need(6).then_some(Verdict::Drop(6, 0)),
        // ClientCutText: a length, negative for the extended clipboard.
        6 => {
            if !need(8) {
                return Ok(None);
            }
            let length = i32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
            let body = u64::from(length.unsigned_abs());
            if body > MAX_DROPPED_CUT_TEXT_BYTES {
                return Err("the viewer sent oversized clipboard text");
            }
            Some(Verdict::Drop(8, body))
        }
        // EnableContinuousUpdates.
        150 => need(10).then_some(Verdict::Forward(10)),
        // ClientFence: flags, then at most 64 bytes of payload.
        248 => {
            if !need(9) {
                return Ok(None);
            }
            let payload = usize::from(bytes[8]);
            if payload > 64 {
                return Err("the viewer sent an invalid fence");
            }
            need(9 + payload).then_some(Verdict::Forward(9 + payload))
        }
        // SetDesktopSize: resizes the screen everyone shares.
        251 => {
            if !need(8) {
                return Ok(None);
            }
            let length = 8 + 16 * usize::from(bytes[6]);
            need(length).then_some(Verdict::Drop(length, 0))
        }
        // xvp: shutdown, reboot or reset of the machine.
        252 => need(4).then_some(Verdict::Drop(4, 0)),
        // QEMU extended key event; other QEMU messages are not passed.
        255 => {
            if !need(2) {
                return Ok(None);
            }
            if bytes[1] != 0 {
                return Err("the viewer sent a message this lane does not pass");
            }
            need(12).then_some(Verdict::Drop(12, 0))
        }
        _ => return Err("the viewer sent a message this lane does not pass"),
    };
    Ok(verdict)
}

/// `GET /browser/vnc/view`: the view-only RFB lane, for anyone with
/// `browser.view`. It counts against the same pixel-stream caps as the other
/// viewers and closes when the grant expires.
pub(crate) async fn handle_vnc_view_ws(
    _ready: BrowserHostReady,
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    ws: WebSocketUpgrade,
) -> Result<Response, OriginError> {
    let expires_at = validated_claim_expiry(&claims)?;
    let pixel_admission = state.browser_collaboration.admit_pixel_stream(&claims)?;
    let (host, port) = crate::browser::resolve_vnc_target();
    Ok(ws
        .max_message_size(MAX_CLIENT_FRAME_BYTES)
        .max_frame_size(MAX_CLIENT_FRAME_BYTES)
        .on_upgrade(move |socket| async move {
            let _pixel_admission = pixel_admission;
            bridge_vnc_view_ws(socket, host, port, expires_at).await;
        }))
}

async fn bridge_vnc_view_ws(socket: WebSocket, host: String, port: u16, expires_at: SystemTime) {
    let tcp = match TcpStream::connect((host.as_str(), port)).await {
        Ok(stream) => stream,
        Err(error) => {
            warn!(?error, host = %host, port, "failed to connect the view-only lane to the VNC target");
            let mut socket = socket;
            let _ = socket.close().await;
            return;
        }
    };
    let _ = tcp.set_nodelay(true);
    let (mut socket_sender, mut socket_receiver) = socket.split();
    let (mut tcp_reader, mut tcp_writer) = tcp.into_split();
    let mut tcp_buf = vec![0u8; 32 * 1024];
    let mut filter = RfbViewOnlyFilter::new();
    let expiry = tokio::time::sleep(
        expires_at
            .duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO),
    );
    tokio::pin!(expiry);

    loop {
        tokio::select! {
            ws_message = socket_receiver.next() => {
                let Some(Ok(message)) = ws_message else { break };
                match message {
                    WsMessage::Binary(data) => {
                        let forward = match filter.feed(&data) {
                            Ok(forward) => forward,
                            Err(reason) => {
                                warn!(reason, "closing the view-only browser lane");
                                break;
                            }
                        };
                        if !forward.is_empty() && tcp_writer.write_all(&forward).await.is_err() {
                            break;
                        }
                    }
                    WsMessage::Ping(payload) => {
                        let _ = socket_sender.send(WsMessage::Pong(payload)).await;
                    }
                    WsMessage::Close(_) => break,
                    // noVNC speaks binary; anything else carries nothing.
                    WsMessage::Text(_) | WsMessage::Pong(_) => {}
                }
            }
            tcp_read = tcp_reader.read(&mut tcp_buf) => {
                match tcp_read {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if socket_sender.send(WsMessage::Binary(tcp_buf[..n].to_vec())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            _ = &mut expiry => break,
        }
    }
    let _ = socket_sender.send(WsMessage::Close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handshake() -> Vec<u8> {
        let mut bytes = RFB_VERSION_3_8.to_vec();
        bytes.push(SECURITY_NONE);
        bytes.push(0); // An exclusive ClientInit, which the lane makes shared.
        bytes
    }

    fn key_event() -> Vec<u8> {
        vec![4, 1, 0, 0, 0, 0, 0xff, 0x0d]
    }

    fn pointer_event() -> Vec<u8> {
        vec![5, 1, 0, 10, 0, 20]
    }

    fn update_request() -> Vec<u8> {
        vec![3, 1, 0, 0, 0, 0, 0x05, 0x00, 0x02, 0xd0]
    }

    fn set_encodings() -> Vec<u8> {
        let mut bytes = vec![2, 0, 0, 2];
        bytes.extend_from_slice(&7i32.to_be_bytes());
        bytes.extend_from_slice(&(-223i32).to_be_bytes());
        bytes
    }

    #[test]
    fn passes_the_handshake_as_a_shared_session() {
        let mut filter = RfbViewOnlyFilter::new();
        let forwarded = filter.feed(&handshake()).expect("handshake");
        let mut expected = RFB_VERSION_3_8.to_vec();
        expected.extend_from_slice(&[SECURITY_NONE, SHARED_SESSION]);
        assert_eq!(forwarded, expected);
    }

    #[test]
    fn drops_every_key_pointer_clipboard_resize_and_power_message() {
        let mut filter = RfbViewOnlyFilter::new();
        filter.feed(&handshake()).expect("handshake");
        let mut input = Vec::new();
        input.extend(key_event());
        input.extend(pointer_event());
        // Clipboard text, classic and extended.
        input.extend([6, 0, 0, 0, 0, 0, 0, 5]);
        input.extend(b"hello");
        input.extend([6, 0, 0, 0]);
        input.extend((-4i32).to_be_bytes());
        input.extend([0, 0, 0, 1]);
        // SetDesktopSize with one screen.
        input.extend([251, 0, 0x05, 0x00, 0x02, 0xd0, 1, 0]);
        input.extend([0u8; 16]);
        // xvp and a QEMU extended key event.
        input.extend([252, 0, 1, 2]);
        input.extend([255, 0, 0, 1, 0, 0, 0, 0x0d, 0, 0, 0, 0x1c]);
        assert_eq!(filter.feed(&input).expect("input"), Vec::<u8>::new());
    }

    #[test]
    fn passes_the_messages_that_ask_for_pixels() {
        let mut filter = RfbViewOnlyFilter::new();
        filter.feed(&handshake()).expect("handshake");
        let mut pixel_format = vec![0, 0, 0, 0];
        pixel_format.extend([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
        let fence = vec![248, 0, 0, 0, 0, 0, 0, 1, 2, 0xaa, 0xbb];
        let continuous = vec![150, 1, 0, 0, 0, 0, 0x05, 0x00, 0x02, 0xd0];
        let mut input = Vec::new();
        for message in [
            &pixel_format,
            &set_encodings(),
            &update_request(),
            &fence,
            &continuous,
        ] {
            input.extend_from_slice(message);
        }
        assert_eq!(filter.feed(&input).expect("input"), input);
    }

    #[test]
    fn keeps_message_boundaries_across_frames() {
        let mut filter = RfbViewOnlyFilter::new();
        let handshake = handshake();
        // The handshake one byte at a time.
        let mut forwarded = Vec::new();
        for byte in &handshake {
            forwarded.extend(filter.feed(&[*byte]).expect("handshake byte"));
        }
        assert_eq!(forwarded.len(), handshake.len());
        // A pointer event split over two frames, then an update request whose
        // first byte shares the pointer event's second frame.
        let pointer = pointer_event();
        let request = update_request();
        assert_eq!(
            filter.feed(&pointer[..3]).expect("first half"),
            Vec::<u8>::new()
        );
        let mut second = pointer[3..].to_vec();
        second.extend_from_slice(&request[..1]);
        assert_eq!(filter.feed(&second).expect("second half"), Vec::<u8>::new());
        assert_eq!(filter.feed(&request[1..]).expect("rest"), request);
        // Clipboard text whose body arrives in later frames is dropped as it
        // comes, and a key event inside that body is not read as one.
        assert_eq!(
            filter.feed(&[6, 0, 0, 0, 0, 0, 0, 8]).expect("cut header"),
            Vec::<u8>::new()
        );
        assert_eq!(
            filter.feed(&key_event()).expect("cut body"),
            Vec::<u8>::new()
        );
        assert_eq!(filter.feed(&request).expect("after"), request);
    }

    #[test]
    fn closes_on_anything_it_does_not_know() {
        let refused = |bytes: &[u8]| {
            let mut filter = RfbViewOnlyFilter::new();
            filter.feed(bytes).is_err()
        };
        assert!(refused(b"RFB 003.003\n"));
        assert!(refused(b"GET / HTTP/1.1\r\n"));
        let mut vnc_auth = RFB_VERSION_3_8.to_vec();
        vnc_auth.push(2);
        assert!(refused(&vnc_auth));
        for message in [vec![7u8, 0], vec![253, 0, 0, 0], vec![255, 1, 0, 0]] {
            let mut bytes = handshake();
            bytes.extend(message);
            assert!(refused(&bytes), "{bytes:?}");
        }
        let mut huge_cut = handshake();
        huge_cut.extend([6, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff]);
        assert!(refused(&huge_cut));
    }
}
