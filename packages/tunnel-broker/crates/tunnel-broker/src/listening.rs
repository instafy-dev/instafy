//! Whether the site behind a tunnel answers HTTP.
//!
//! Only a process beside rathole can dial a tunnel's rathole port, and the broker API need not
//! run there: a deployment may put it on another node. The ingress sidecar always runs beside
//! its rathole, so every round it probes its own live bindings and records what answered
//! ([`db::record_tunnel_listening`]). A broker beside the tunnel's rathole dials it directly; any
//! other broker answers from that record while it is fresh ([`recorded_listening`]).

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Semaphore,
    task::JoinSet,
};
use uuid::Uuid;

use crate::db::{self, DbPool, ListeningObservation, RatholeBinding, TunnelRecord};

/// The sidecar probes every binding each round, so one slow site must not hold up the round.
pub const SIDECAR_PROBE_TIMEOUT: Duration = Duration::from_secs(1);
const SIDECAR_PROBE_CONCURRENCY: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ProbeResponse {
    pub listening: bool,
    pub status: Option<u16>,
}

impl ProbeResponse {
    pub const DOWN: Self = Self {
        listening: false,
        status: None,
    };
}

/// Rathole accepts the TCP connection even when no client or local server is behind it, so
/// a connect alone proves nothing: only an HTTP status line counts as listening.
pub async fn probe_http(host: &str, port: u16, path: &str, timeout: Duration) -> ProbeResponse {
    let attempt = async {
        let mut stream = TcpStream::connect((host, port)).await.ok()?;
        let request = format!(
            "HEAD {path} HTTP/1.1\r\nHost: localhost\r\nUser-Agent: instafy-preview-probe\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut head = Vec::with_capacity(64);
        let mut buf = [0u8; 256];
        while !head.windows(2).any(|w| w == b"\r\n") && head.len() < 1024 {
            let read = stream.read(&mut buf).await.ok()?;
            if read == 0 {
                break;
            }
            head.extend_from_slice(&buf[..read]);
        }
        parse_status_line(&head)
    };
    match tokio::time::timeout(timeout, attempt).await {
        Ok(Some(status)) => ProbeResponse {
            listening: true,
            status: Some(status),
        },
        _ => ProbeResponse::DOWN,
    }
}

pub(crate) fn parse_status_line(head: &[u8]) -> Option<u16> {
    let line = std::str::from_utf8(head).ok()?.lines().next()?;
    let mut parts = line.split(' ');
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    let code = parts.next()?;
    if code.len() != 3 {
        return None;
    }
    code.parse::<u16>()
        .ok()
        .filter(|code| (100..=599).contains(code))
}

/// `HEAD /` on every binding through `host`, a bounded number at a time.
pub async fn probe_bindings(
    host: &str,
    bindings: &[RatholeBinding],
    timeout: Duration,
) -> Vec<ListeningObservation> {
    let permits = Arc::new(Semaphore::new(SIDECAR_PROBE_CONCURRENCY));
    let mut probes = JoinSet::new();
    for binding in bindings {
        let Ok(port) = u16::try_from(binding.rathole_port) else {
            continue;
        };
        let host = host.to_string();
        let permits = permits.clone();
        let tunnel_id = binding.tunnel_id;
        let rathole_port = binding.rathole_port;
        probes.spawn(async move {
            let _permit = permits.acquire_owned().await.ok();
            let seen = probe_http(&host, port, "/", timeout).await;
            ListeningObservation {
                tunnel_id,
                rathole_port,
                status: seen.status,
            }
        });
    }
    let mut observations = Vec::with_capacity(bindings.len());
    while let Some(probe) = probes.join_next().await {
        if let Ok(observation) = probe {
            observations.push(observation);
        }
    }
    observations
}

/// The ingress sidecar's round: probe this ingress's live bindings and record what answered.
/// Returns the tunnels that just became active.
pub async fn probe_and_record(
    pool: &DbPool,
    upstream_host: &str,
    ingress_id: Uuid,
    bindings: &[RatholeBinding],
) -> Result<Vec<Uuid>> {
    let observations = probe_bindings(upstream_host, bindings, SIDECAR_PROBE_TIMEOUT).await;
    db::record_tunnel_listening(pool, ingress_id, &observations).await
}

/// What a broker that is not beside the tunnel's rathole answers: the sidecar's last record
/// while it is at most `max_age` old, otherwise down. The record is of `HEAD /`; any HTTP
/// status counts as listening, so the requested path does not change the answer.
pub fn recorded_listening(
    record: &TunnelRecord,
    max_age: chrono::Duration,
    now: DateTime<Utc>,
) -> ProbeResponse {
    let fresh = record
        .listening_checked_at
        .is_some_and(|checked_at| now.signed_duration_since(checked_at) <= max_age);
    match record
        .listening_status
        .and_then(|status| u16::try_from(status).ok())
    {
        Some(status) if fresh => ProbeResponse {
            listening: true,
            status: Some(status),
        },
        _ => ProbeResponse::DOWN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

    async fn serve_once(reply: Option<&'static [u8]>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 512];
            let _ = socket.read(&mut buf).await;
            match reply {
                Some(reply) => {
                    let _ = socket.write_all(reply).await;
                }
                // Hold the socket open without answering.
                None => tokio::time::sleep(Duration::from_secs(5)).await,
            }
        });
        port
    }

    fn closed_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    fn binding(port: u16) -> RatholeBinding {
        RatholeBinding {
            tunnel_id: Uuid::new_v4(),
            rathole_service: "tunnel_abc".into(),
            rathole_port: i32::from(port),
            token: "tok".into(),
            hostname: "abc.rt.test".into(),
            visibility: "public".into(),
            kind: "tunnel".into(),
        }
    }

    #[tokio::test]
    async fn reports_listening_with_status() {
        let port = serve_once(Some(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")).await;
        let result = probe_http("127.0.0.1", port, "/", PROBE_TIMEOUT).await;
        assert_eq!(
            result,
            ProbeResponse {
                listening: true,
                status: Some(404)
            }
        );
    }

    #[tokio::test]
    async fn reports_refused_connections_as_down() {
        let result = probe_http("127.0.0.1", closed_port(), "/", PROBE_TIMEOUT).await;
        assert_eq!(result, ProbeResponse::DOWN);
    }

    #[tokio::test]
    async fn reports_timeouts_as_down() {
        let port = serve_once(None).await;
        let started = std::time::Instant::now();
        let result = probe_http("127.0.0.1", port, "/", Duration::from_millis(200)).await;
        assert_eq!(result, ProbeResponse::DOWN);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn reports_closed_without_response_as_down() {
        // What rathole does when the client or the site behind it is gone.
        let port = serve_once(Some(b"")).await;
        let result = probe_http("127.0.0.1", port, "/", PROBE_TIMEOUT).await;
        assert_eq!(result, ProbeResponse::DOWN);
    }

    #[test]
    fn parses_status_lines() {
        assert_eq!(parse_status_line(b"HTTP/1.1 200 OK\r\n"), Some(200));
        assert_eq!(parse_status_line(b"HTTP/1.0 503\r\n"), Some(503));
        assert_eq!(parse_status_line(b"SSH-2.0-OpenSSH\r\n"), None);
        assert_eq!(parse_status_line(b"HTTP/1.1 2000 OK\r\n"), None);
        assert_eq!(parse_status_line(b""), None);
    }

    #[tokio::test]
    async fn probes_every_binding_and_says_which_answered() {
        let answering = binding(serve_once(Some(b"HTTP/1.1 200 OK\r\n\r\n")).await);
        let silent = binding(serve_once(None).await);
        let refused = binding(closed_port());
        let mut seen = probe_bindings(
            "127.0.0.1",
            &[answering.clone(), silent.clone(), refused.clone()],
            Duration::from_millis(300),
        )
        .await;
        seen.sort_by_key(|observation| observation.rathole_port);
        let mut expected = vec![
            ListeningObservation {
                tunnel_id: answering.tunnel_id,
                rathole_port: answering.rathole_port,
                status: Some(200),
            },
            ListeningObservation {
                tunnel_id: silent.tunnel_id,
                rathole_port: silent.rathole_port,
                status: None,
            },
            ListeningObservation {
                tunnel_id: refused.tunnel_id,
                rathole_port: refused.rathole_port,
                status: None,
            },
        ];
        expected.sort_by_key(|observation| observation.rathole_port);
        assert_eq!(seen, expected);
    }

    #[test]
    fn answers_from_a_fresh_record_only() {
        let now = Utc::now();
        let max_age = chrono::Duration::seconds(30);
        let record = |checked_ago: Option<i64>, status: Option<i32>| TunnelRecord {
            listening_checked_at: checked_ago.map(|ago| now - chrono::Duration::seconds(ago)),
            listening_status: status,
            ..db::test_tunnel_record()
        };
        assert_eq!(
            recorded_listening(&record(Some(5), Some(200)), max_age, now),
            ProbeResponse {
                listening: true,
                status: Some(200)
            }
        );
        assert_eq!(
            recorded_listening(&record(Some(30), Some(404)), max_age, now),
            ProbeResponse {
                listening: true,
                status: Some(404)
            }
        );
        // Nothing answered at the last round.
        assert_eq!(
            recorded_listening(&record(Some(5), None), max_age, now),
            ProbeResponse::DOWN
        );
        // The sidecar stopped recording: its last answer no longer says anything.
        assert_eq!(
            recorded_listening(&record(Some(31), Some(200)), max_age, now),
            ProbeResponse::DOWN
        );
        assert_eq!(
            recorded_listening(&record(None, None), max_age, now),
            ProbeResponse::DOWN
        );
    }
}
