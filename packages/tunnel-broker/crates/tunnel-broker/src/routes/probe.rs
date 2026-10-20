use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use uuid::Uuid;

use crate::{
    db,
    error::{AppError, AppResult},
    state::AppState,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PROBE_PATH_LEN: usize = 2048;

#[derive(Debug, Deserialize)]
pub struct ProbeQuery {
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ProbeResponse {
    pub listening: bool,
    pub status: Option<u16>,
}

impl ProbeResponse {
    const DOWN: Self = Self {
        listening: false,
        status: None,
    };
}

/// `GET /tunnels/:id/probe?path=/`: is the site behind this tunnel answering HTTP right now?
pub async fn probe(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<ProbeQuery>,
) -> AppResult<Json<ProbeResponse>> {
    let path = probe_path(query.path.as_deref())?;
    let Some(record) = db::get_tunnel(state.pool(), id).await? else {
        return Err(db::not_found(id));
    };
    let port = record
        .rathole_port
        .filter(|_| !record.status.trim().eq_ignore_ascii_case("revoked"))
        .and_then(|port| u16::try_from(port).ok());
    let Some(port) = port else {
        return Ok(Json(ProbeResponse::DOWN));
    };
    Ok(Json(
        probe_http(
            &state.config().rathole_upstream_host,
            port,
            &path,
            PROBE_TIMEOUT,
        )
        .await,
    ))
}

/// The path goes straight into a request line, so only visible ASCII is accepted.
fn probe_path(raw: Option<&str>) -> AppResult<String> {
    let path = raw
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("/");
    let valid = path.starts_with('/')
        && path.len() <= MAX_PROBE_PATH_LEN
        && path.bytes().all(|b| b.is_ascii_graphic());
    if !valid {
        return Err(AppError::bad_request(
            "path must be an absolute request path",
        ));
    }
    Ok(path.to_string())
}

/// Rathole accepts the TCP connection even when no client or local server is behind it, so
/// a connect alone proves nothing: only an HTTP status line counts as listening.
pub(crate) async fn probe_http(
    host: &str,
    port: u16,
    path: &str,
    timeout: Duration,
) -> ProbeResponse {
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

fn parse_status_line(head: &[u8]) -> Option<u16> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

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
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let result = probe_http("127.0.0.1", port, "/", PROBE_TIMEOUT).await;
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
    fn validates_probe_paths() {
        assert_eq!(probe_path(None).unwrap(), "/");
        assert_eq!(probe_path(Some("")).unwrap(), "/");
        assert_eq!(probe_path(Some("/site/?q=1")).unwrap(), "/site/?q=1");
        assert!(probe_path(Some("site")).is_err());
        assert!(probe_path(Some("/a b")).is_err());
        assert!(probe_path(Some("/a\r\nHost: evil")).is_err());
        assert!(probe_path(Some(&format!("/{}", "a".repeat(MAX_PROBE_PATH_LEN)))).is_err());
    }

    #[test]
    fn parses_status_lines() {
        assert_eq!(parse_status_line(b"HTTP/1.1 200 OK\r\n"), Some(200));
        assert_eq!(parse_status_line(b"HTTP/1.0 503\r\n"), Some(503));
        assert_eq!(parse_status_line(b"SSH-2.0-OpenSSH\r\n"), None);
        assert_eq!(parse_status_line(b"HTTP/1.1 2000 OK\r\n"), None);
        assert_eq!(parse_status_line(b""), None);
    }
}
