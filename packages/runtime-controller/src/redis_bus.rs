use std::time::Duration;

use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_stream::StreamExt;
use tracing::{debug, info, warn};

use crate::state::{ControllerEvent, EventHub};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedisEventEnvelope {
    source: String,
    event: ControllerEvent,
}

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

    tokio::spawn(run_publisher(
        redis_url.clone(),
        channel.clone(),
        source_id.clone(),
        outbound,
    ));
    tokio::spawn(run_subscriber(redis_url, channel, source_id, hub));
}

async fn run_publisher(
    redis_url: String,
    channel: String,
    source_id: String,
    mut outbound: mpsc::Receiver<ControllerEvent>,
) {
    let mut manager: Option<redis::aio::ConnectionManager> = None;
    let mut backoff = Duration::from_secs(1);
    let mut next_connect_at = Instant::now();

    while let Some(event) = outbound.recv().await {
        if manager.is_none() && Instant::now() >= next_connect_at {
            match connect_manager(&redis_url).await {
                Ok(connection) => {
                    manager = Some(connection);
                    backoff = Duration::from_secs(1);
                    next_connect_at = Instant::now();
                    info!(redis_channel = %channel, "redis publisher connected");
                }
                Err(error) => {
                    warn!(%error, redis_channel = %channel, "redis event publisher failed to connect");
                    next_connect_at = Instant::now() + backoff;
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                }
            }
        }

        let payload = match serde_json::to_string(&RedisEventEnvelope {
            source: source_id.clone(),
            event,
        }) {
            Ok(payload) => payload,
            Err(error) => {
                warn!(
                    ?error,
                    "failed to serialize redis controller event envelope"
                );
                continue;
            }
        };

        let Some(connection) = manager.as_mut() else {
            continue;
        };

        let result: redis::RedisResult<i32> = connection.publish(channel.as_str(), payload).await;
        if let Err(error) = result {
            warn!(%error, "failed to publish controller event to redis");
            manager = None;
            next_connect_at = Instant::now() + backoff;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }
}

async fn run_subscriber(redis_url: String, channel: String, source_id: String, hub: EventHub) {
    let client = match redis::Client::open(redis_url.as_str()) {
        Ok(client) => client,
        Err(error) => {
            warn!(%error, "redis event subscriber failed to parse redis url");
            return;
        }
    };

    let mut backoff = Duration::from_secs(1);
    loop {
        match client.get_async_pubsub().await {
            Ok(mut pubsub) => {
                backoff = Duration::from_secs(1);
                if let Err(error) = pubsub.subscribe(channel.as_str()).await {
                    warn!(%error, redis_channel = %channel, "redis pubsub subscribe failed");
                } else {
                    info!(redis_channel = %channel, "redis pubsub subscribed");
                }

                let mut stream = pubsub.on_message();
                while let Some(msg) = stream.next().await {
                    let payload: String = match msg.get_payload() {
                        Ok(payload) => payload,
                        Err(error) => {
                            warn!(%error, "failed to decode redis pubsub payload");
                            continue;
                        }
                    };

                    let envelope: RedisEventEnvelope = match serde_json::from_str(&payload) {
                        Ok(envelope) => envelope,
                        Err(error) => {
                            let preview: String = payload.chars().take(240).collect();
                            debug!(
                                ?error,
                                payload_preview = %preview,
                                "failed to parse redis controller event envelope"
                            );
                            continue;
                        }
                    };

                    if envelope.source == source_id {
                        continue;
                    }

                    hub.publish_local(envelope.event);
                }
            }
            Err(error) => {
                warn!(%error, "redis pubsub connection failed");
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
