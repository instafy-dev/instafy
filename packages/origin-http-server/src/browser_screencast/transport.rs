use std::collections::VecDeque;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value as JsonValue};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as TungMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::error::OriginError;

const CDP_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
pub(super) const INPUT_MESSAGES_PER_SECOND: u32 = 240;

pub(super) type CdpSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub(super) type ClientSender = futures_util::stream::SplitSink<WebSocket, WsMessage>;

#[derive(Debug)]
pub(super) struct ResolvedTarget {
    pub id: String,
    pub websocket_url: String,
}

#[derive(Debug)]
pub(super) struct InputRateLimit {
    accepted_at: VecDeque<Instant>,
    limit: usize,
    window: Duration,
}

impl InputRateLimit {
    pub fn new() -> Self {
        Self::with_limit(INPUT_MESSAGES_PER_SECOND as usize, Duration::from_secs(1))
    }

    pub fn with_limit(limit: usize, window: Duration) -> Self {
        debug_assert!(limit > 0);
        debug_assert!(!window.is_zero());
        Self {
            accepted_at: VecDeque::with_capacity(limit),
            limit,
            window,
        }
    }

    pub fn take(&mut self) -> bool {
        self.take_at(Instant::now())
    }

    fn take_at(&mut self, now: Instant) -> bool {
        while self
            .accepted_at
            .front()
            .is_some_and(|accepted_at| now.saturating_duration_since(*accepted_at) >= self.window)
        {
            self.accepted_at.pop_front();
        }
        if self.accepted_at.len() >= self.limit {
            return false;
        }
        self.accepted_at.push_back(now);
        true
    }

    pub fn reset(&mut self) {
        self.accepted_at.clear();
    }
}

pub(super) fn cdp_command(id: u64, method: &str, params: JsonValue) -> TungMessage {
    TungMessage::Text(
        json!({
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string(),
    )
}

pub(super) async fn send_cdp_command_and_wait(
    socket: &mut CdpSocket,
    id: u64,
    method: &str,
    params: JsonValue,
) -> Result<JsonValue, OriginError> {
    timeout(CDP_COMMAND_TIMEOUT, async {
        socket
            .send(cdp_command(id, method, params))
            .await
            .map_err(|error| {
                OriginError::unavailable(format!("failed to send browser CDP command: {error}"))
            })?;
        while let Some(message) = socket.next().await {
            let message = message.map_err(|error| {
                OriginError::unavailable(format!("browser CDP response failed: {error}"))
            })?;
            let payload = match message {
                TungMessage::Text(text) => serde_json::from_str::<JsonValue>(&text).ok(),
                TungMessage::Binary(bytes) => serde_json::from_slice::<JsonValue>(&bytes).ok(),
                TungMessage::Ping(payload) => {
                    socket
                        .send(TungMessage::Pong(payload))
                        .await
                        .map_err(|error| {
                            OriginError::unavailable(format!("browser CDP pong failed: {error}"))
                        })?;
                    None
                }
                TungMessage::Close(_) => {
                    return Err(OriginError::unavailable(
                        "browser CDP closed during screencast setup",
                    ));
                }
                _ => None,
            };
            let Some(payload) = payload else {
                continue;
            };
            if payload.get("id").and_then(JsonValue::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = payload.get("error") {
                let message = error
                    .get("message")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("command rejected");
                return Err(OriginError::unavailable(format!(
                    "browser CDP rejected {method}: {}",
                    message.chars().take(256).collect::<String>()
                )));
            }
            return Ok(payload.get("result").cloned().unwrap_or(JsonValue::Null));
        }
        Err(OriginError::unavailable(
            "browser CDP closed during screencast setup",
        ))
    })
    .await
    .map_err(|_| OriginError::unavailable("browser CDP screencast setup timed out"))?
}

pub(super) async fn send_client_json(sender: &mut ClientSender, payload: JsonValue) -> bool {
    sender
        .send(WsMessage::Text(payload.to_string()))
        .await
        .is_ok()
}
