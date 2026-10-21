use std::collections::HashSet;
use std::time::Duration;

use redis::AsyncCommands;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_stream::StreamExt;
use tracing::{debug, info, warn};

use crate::previews::{FollowBusMessage, FollowEnvelope, FollowHub};
use crate::state::{ControllerEvent, EventHub};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedisEventEnvelope {
    source: String,
    event: ControllerEvent,
}

/// Most messages one publish round takes from a queue.
const PUBLISH_BATCH: usize = 256;

/// The controller event bus (`<ns>:controller:events`).
pub(crate) fn spawn(
    redis_url: String,
    channel: String,
    hub: EventHub,
    outbound: mpsc::Receiver<ControllerEvent>,
) {
    let source_id = uuid::Uuid::new_v4().to_string();

    info!(
        redis_channel = %channel,
        source_id = %source_id,
        "redis event bus enabled"
    );

    let source = source_id.clone();
    spawn_channel(
        redis_url,
        channel,
        "events",
        outbound,
        move |batch: Vec<ControllerEvent>| {
            batch
                .into_iter()
                .map(|event| RedisEventEnvelope {
                    source: source.clone(),
                    event,
                })
                .collect()
        },
        move |envelope: RedisEventEnvelope| {
            if envelope.source != source_id {
                hub.publish_local(envelope.event);
            }
        },
    );
}

/// Follow mode's bus (`<ns>:controller:follow`): its own connection and
/// queue on the same channel mechanism as the event bus, with a burst of
/// views thinned before publishing. Envelopes already name their node; a
/// node skips its own (`FollowHub::receive`).
pub(crate) fn spawn_follow(
    redis_url: String,
    channel: String,
    hub: FollowHub,
    outbound: mpsc::Receiver<FollowEnvelope>,
) {
    info!(redis_channel = %channel, node = %hub.node_id(), "redis follow bus enabled");
    spawn_channel(
        redis_url,
        channel,
        "follow",
        outbound,
        coalesce_follow_batch,
        move |envelope: FollowEnvelope| hub.receive(envelope),
    );
}

/// One Redis pub/sub channel between controller nodes. The publisher takes
/// what is waiting in `outbound` (up to [`PUBLISH_BATCH`] at a time), lets
/// `prepare` wrap or thin the batch and publishes each message as JSON; the
/// subscriber hands every message it can read to `on_message`. Both
/// reconnect with backoff (1 s, doubling to 30 s); while Redis cannot be
/// reached, messages are dropped. Payloads are never logged, only their size.
fn spawn_channel<T, W, P, H>(
    redis_url: String,
    channel: String,
    bus: &'static str,
    outbound: mpsc::Receiver<T>,
    prepare: P,
    on_message: H,
) where
    T: Send + 'static,
    W: Serialize + DeserializeOwned + Send + 'static,
    P: Fn(Vec<T>) -> Vec<W> + Send + 'static,
    H: Fn(W) + Send + 'static,
{
    tokio::spawn(run_publisher(
        redis_url.clone(),
        channel.clone(),
        bus,
        outbound,
        prepare,
    ));
    tokio::spawn(run_subscriber(redis_url, channel, bus, on_message));
}

async fn run_publisher<T, W, P>(
    redis_url: String,
    channel: String,
    bus: &'static str,
    mut outbound: mpsc::Receiver<T>,
    prepare: P,
) where
    W: Serialize,
    P: Fn(Vec<T>) -> Vec<W>,
{
    let mut manager: Option<redis::aio::ConnectionManager> = None;
    let mut backoff = Duration::from_secs(1);
    let mut next_connect_at = Instant::now();

    while let Some(first) = outbound.recv().await {
        let mut batch = vec![first];
        while batch.len() < PUBLISH_BATCH {
            match outbound.try_recv() {
                Ok(message) => batch.push(message),
                Err(_) => break,
            }
        }

        if manager.is_none() && Instant::now() >= next_connect_at {
            match connect_manager(&redis_url).await {
                Ok(connection) => {
                    manager = Some(connection);
                    backoff = Duration::from_secs(1);
                    info!(redis_channel = %channel, bus, "redis publisher connected");
                }
                Err(error) => {
                    warn!(%error, redis_channel = %channel, bus, "redis publisher failed to connect");
                    next_connect_at = Instant::now() + backoff;
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                }
            }
        }

        let Some(connection) = manager.as_mut() else {
            continue;
        };

        for message in prepare(batch) {
            let payload = match serde_json::to_string(&message) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!(?error, bus, "failed to serialize a redis bus message");
                    continue;
                }
            };
            let result: redis::RedisResult<i32> =
                connection.publish(channel.as_str(), payload).await;
            if let Err(error) = result {
                warn!(%error, bus, "failed to publish to redis");
                manager = None;
                next_connect_at = Instant::now() + backoff;
                backoff = (backoff * 2).min(Duration::from_secs(30));
                break;
            }
        }
    }
}

async fn run_subscriber<W, H>(redis_url: String, channel: String, bus: &'static str, on_message: H)
where
    W: DeserializeOwned,
    H: Fn(W),
{
    let client = match redis::Client::open(redis_url.as_str()) {
        Ok(client) => client,
        Err(error) => {
            warn!(%error, bus, "redis subscriber failed to parse redis url");
            return;
        }
    };

    let mut backoff = Duration::from_secs(1);
    loop {
        match client.get_async_pubsub().await {
            Ok(mut pubsub) => {
                backoff = Duration::from_secs(1);
                if let Err(error) = pubsub.subscribe(channel.as_str()).await {
                    warn!(%error, redis_channel = %channel, bus, "redis pubsub subscribe failed");
                } else {
                    info!(redis_channel = %channel, bus, "redis pubsub subscribed");
                }

                let mut stream = pubsub.on_message();
                while let Some(msg) = stream.next().await {
                    let payload: String = match msg.get_payload() {
                        Ok(payload) => payload,
                        Err(error) => {
                            warn!(%error, bus, "failed to decode redis pubsub payload");
                            continue;
                        }
                    };
                    match serde_json::from_str::<W>(&payload) {
                        Ok(message) => on_message(message),
                        Err(error) => {
                            debug!(
                                ?error,
                                bus,
                                bytes = payload.len(),
                                "unreadable redis bus message"
                            );
                        }
                    }
                }
            }
            Err(error) => {
                warn!(%error, bus, "redis pubsub connection failed");
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn connect_manager(redis_url: &str) -> redis::RedisResult<redis::aio::ConnectionManager> {
    let client = redis::Client::open(redis_url)?;
    redis::aio::ConnectionManager::new(client).await
}

/// Drop views a later message in the same batch makes pointless: an
/// earlier view of a preview when a later one carries a payload, and an
/// earlier heartbeat when a later heartbeat follows. Everything else keeps
/// its order. Only views (the 10 Hz part) are ever dropped.
pub(crate) fn coalesce_follow_batch(batch: Vec<FollowEnvelope>) -> Vec<FollowEnvelope> {
    let mut later_payload = HashSet::new();
    let mut later_heartbeat = HashSet::new();
    let mut kept = Vec::with_capacity(batch.len());
    for envelope in batch.into_iter().rev() {
        if let FollowBusMessage::View {
            preview_id,
            presentation_id,
            payload,
            ..
        } = &envelope.message
        {
            let key = (preview_id.clone(), *presentation_id);
            if later_payload.contains(&key) {
                continue;
            }
            if payload.is_some() {
                later_payload.insert(key);
            } else if !later_heartbeat.insert(key) {
                continue;
            }
        }
        kept.push(envelope);
    }
    kept.reverse();
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ControllerEvent;

    /// An event without channels leaves `channels` out on the wire; the
    /// other node must still read it.
    #[test]
    fn an_event_without_channels_survives_the_wire() {
        let envelope = RedisEventEnvelope {
            source: "a".to_string(),
            event: ControllerEvent {
                kind: "bus.test".to_string(),
                project_id: None,
                session_id: None,
                conversation_id: None,
                run_id: None,
                job_id: None,
                channel: None,
                channels: Vec::new(),
                target_user_id: None,
                data: serde_json::json!({ "n": 1 }),
                timestamp: chrono::Utc::now(),
            },
        };
        let wire = serde_json::to_string(&envelope).unwrap();
        assert!(!wire.contains("channels"));
        let read: RedisEventEnvelope = serde_json::from_str(&wire).expect("readable");
        assert_eq!(read.event.kind, "bus.test");
        assert!(read.event.channels.is_empty());
    }

    /// Two event buses through a real Redis, when `FOLLOW_TEST_REDIS_URL`
    /// names one: an event published on one node reaches the other's
    /// streams, and never comes back to its own.
    #[tokio::test]
    async fn two_event_buses_meet_through_redis_when_one_is_available() -> anyhow::Result<()> {
        let Ok(redis_url) = std::env::var("FOLLOW_TEST_REDIS_URL") else {
            eprintln!("FOLLOW_TEST_REDIS_URL unset; skipping the Redis event bus test");
            return Ok(());
        };
        let channel = format!("events-test:{}:controller:events", uuid::Uuid::new_v4());
        let (a_hub, b_hub) = (EventHub::new(), EventHub::new());
        let (a_tx, a_rx) = mpsc::channel(16);
        let (_b_tx, b_rx) = mpsc::channel(16);
        spawn(redis_url.clone(), channel.clone(), a_hub.clone(), a_rx);
        spawn(redis_url, channel, b_hub.clone(), b_rx);
        tokio::time::sleep(Duration::from_millis(500)).await;
        let mut on_a = a_hub.subscribe();
        let mut on_b = b_hub.subscribe();
        let event = ControllerEvent {
            kind: "bus.test".to_string(),
            project_id: None,
            session_id: None,
            conversation_id: None,
            run_id: None,
            job_id: None,
            channel: None,
            channels: Vec::new(),
            target_user_id: None,
            data: serde_json::json!({ "n": 1 }),
            timestamp: chrono::Utc::now(),
        };
        a_tx.send(event).await?;
        let received = tokio::time::timeout(Duration::from_secs(5), on_b.recv()).await??;
        assert_eq!(received.kind, "bus.test");
        assert_eq!(received.data, serde_json::json!({ "n": 1 }));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(on_a.try_recv().is_err(), "a node's own event came back");
        Ok(())
    }
}
