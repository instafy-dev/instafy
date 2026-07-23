use std::io;
use std::process::Stdio;

use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use bytes::Bytes;
use futures_util::{stream, StreamExt, TryStreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::io::ReaderStream;
use tracing::warn;

use crate::error::ServiceError;

const MAX_HEADER_BYTES: usize = 64 * 1024;

pub async fn run_git_http_backend(
    repo_root: &str,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response, ServiceError> {
    let path = uri.path();
    let query = uri.query().unwrap_or("");

    let mut child = Command::new("git")
        .arg("http-backend")
        .env("GIT_PROJECT_ROOT", repo_root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("PATH_INFO", path)
        .env("REQUEST_METHOD", method.as_str())
        .env("QUERY_STRING", query)
        .env("REMOTE_ADDR", "0.0.0.0")
        .env(
            "CONTENT_TYPE",
            header_to_str(headers, axum::http::header::CONTENT_TYPE).unwrap_or(""),
        )
        .env(
            "CONTENT_LENGTH",
            header_to_str(headers, axum::http::header::CONTENT_LENGTH).unwrap_or(""),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            ServiceError::internal(format!("failed to spawn git http-backend: {error}"))
        })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ServiceError::internal("git child stdin missing"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ServiceError::internal("git child stdout missing"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| ServiceError::internal("git child stderr missing"))?;

    let mut body_reader = tokio_util::io::StreamReader::new(
        body.into_data_stream()
            .map_err(|error| io::Error::new(io::ErrorKind::Other, error)),
    );

    tokio::spawn(async move {
        let copy_res = tokio::io::copy(&mut body_reader, &mut stdin).await;
        let _ = stdin.shutdown().await;
        if let Err(error) = copy_res {
            warn!(?error, "git http-backend stdin copy failed");
        }
    });

    tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Ok(_) = stderr.read_to_end(&mut buf).await {
            if !buf.is_empty() {
                warn!(stderr = %String::from_utf8_lossy(&buf), "git http-backend stderr");
            }
        }
    });

    let (status, headers_out, response_body) = parse_cgi_response(stdout).await?;

    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                if !status.success() {
                    warn!(?status, "git http-backend exited with non-zero status");
                }
            }
            Err(error) => warn!(?error, "git http-backend wait failed"),
        }
    });

    let mut response = Response::new(response_body);
    *response.status_mut() = status;
    *response.headers_mut() = headers_out;
    Ok(response)
}

fn header_to_str(headers: &HeaderMap, key: axum::http::header::HeaderName) -> Option<&str> {
    headers.get(key).and_then(|value| value.to_str().ok())
}

async fn parse_cgi_response(
    stdout: tokio::process::ChildStdout,
) -> Result<(StatusCode, HeaderMap, Body), ServiceError> {
    let mut stdout = stdout;
    let mut buffer = Vec::new();
    let (header_end, delimiter_len) = loop {
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(ServiceError::internal("git CGI headers too large"));
        }
        if let Some(pos) = find_header_delimiter(&buffer) {
            break pos;
        }
        let mut chunk = [0u8; 8192];
        let n = stdout
            .read(&mut chunk)
            .await
            .map_err(|error| ServiceError::internal(format!("git stdout read failed: {error}")))?;
        if n == 0 {
            return Err(ServiceError::internal(
                "git http-backend returned no headers",
            ));
        }
        buffer.extend_from_slice(&chunk[..n]);
    };

    let header_bytes = &buffer[..header_end];
    let remainder = buffer[(header_end + delimiter_len)..].to_vec();

    let header_text = String::from_utf8_lossy(header_bytes);
    let mut status = StatusCode::OK;
    let mut headers_out = HeaderMap::new();

    for raw_line in header_text.split('\n') {
        let line = raw_line.trim_end_matches('\r').trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("Status:") {
            if let Some(code_str) = rest.trim().split_whitespace().next() {
                if let Ok(code) = code_str.parse::<u16>() {
                    if let Ok(parsed) = StatusCode::from_u16(code) {
                        status = parsed;
                    }
                }
            }
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() {
            continue;
        }
        if let (Ok(header_name), Ok(header_value)) = (
            axum::http::header::HeaderName::from_bytes(name.as_bytes()),
            axum::http::HeaderValue::from_str(value),
        ) {
            headers_out.append(header_name, header_value);
        }
    }

    let stdout_stream = ReaderStream::new(stdout).map_err(|error| {
        io::Error::new(
            io::ErrorKind::Other,
            format!("git stdout stream error: {error}"),
        )
    });

    let body_stream = if remainder.is_empty() {
        stdout_stream.boxed()
    } else {
        stream::once(async move { Ok::<Bytes, io::Error>(Bytes::from(remainder)) })
            .chain(stdout_stream)
            .boxed()
    };

    Ok((status, headers_out, Body::from_stream(body_stream)))
}

fn find_header_delimiter(buf: &[u8]) -> Option<(usize, usize)> {
    // Prefer CRLF delimiter.
    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
        return Some((pos, 4));
    }
    if let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
        return Some((pos, 2));
    }
    None
}
