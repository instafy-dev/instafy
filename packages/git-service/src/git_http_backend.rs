use std::io;
use std::process::Stdio;

use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use bytes::Bytes;
use futures_util::{stream, StreamExt, TryStreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio_util::io::ReaderStream;
use tracing::warn;

use crate::error::ServiceError;
use crate::policy::{PUSH_REPORT_ENV, SALVAGE_PUSH_ENV};

const MAX_HEADER_BYTES: usize = 64 * 1024;

/// Where and how one `git http-backend` request runs.
pub struct GitHttpBackendOptions<'a> {
    /// `GIT_PROJECT_ROOT`: the directory holding the bare repositories.
    pub repo_root: &'a str,
    /// Absolute shared hooks directory, passed as `core.hooksPath`.
    pub hooks_dir: &'a str,
    /// Largest pack a push may send, passed as `receive.maxInputSize`.
    pub max_push_bytes: u64,
    /// File the shared `post-receive` hook appends this push's ref updates
    /// to. `None` for requests whose updates nobody reads.
    pub push_report: Option<&'a str>,
    /// Mark this push as a salvage push ([`SALVAGE_PUSH_ENV`]). Only for a
    /// request the shard authorized with the exact salvage credential.
    pub salvage_push: bool,
}

pub struct GitHttpBackendResponse {
    pub response: Response,
    /// Resolves once `git http-backend` (and the `git receive-pack` or
    /// `git upload-pack` it runs) has exited. Every ref update of a push is
    /// done by then, and the response body has been fully produced.
    pub finished: oneshot::Receiver<()>,
}

/// Command-scope Git configuration for every `git http-backend` run.
///
/// It is passed as `GIT_CONFIG_COUNT` entries (git 2.31+), which outrank every
/// config file, so a repository's own `core.hooksPath`, `hooks/` directory or
/// receive settings are never used, and nothing is written to repository
/// config.
fn backend_config(options: &GitHttpBackendOptions<'_>) -> Vec<(&'static str, String)> {
    vec![
        ("core.hooksPath", options.hooks_dir.to_string()),
        ("http.receivepack", "true".to_string()),
        // Reject malformed objects, including trees with `..` or `.git`
        // entries and unsafe `.gitmodules`, before any ref moves. A rejected
        // pack is discarded with its quarantine directory.
        ("receive.fsckObjects", "true".to_string()),
        ("transfer.fsckObjects", "true".to_string()),
        ("receive.maxInputSize", options.max_push_bytes.to_string()),
    ]
}

/// Inherited environment that must never reach `git http-backend` or a hook.
const REMOVED_BACKEND_ENV: [&str; 3] = [
    // `-c` style parameters are read after GIT_CONFIG_COUNT and would win, so
    // an inherited value could replace the shared hooks directory.
    "GIT_CONFIG_PARAMETERS",
    // Hook environment comes only from the shard, per request. Request
    // headers are never turned into environment variables, and the salvage
    // flag is set only from `GitHttpBackendOptions::salvage_push`.
    SALVAGE_PUSH_ENV,
    PUSH_REPORT_ENV,
];

/// `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` for
/// [`backend_config`].
fn backend_config_env(options: &GitHttpBackendOptions<'_>) -> Vec<(String, String)> {
    let config = backend_config(options);
    let mut env = vec![("GIT_CONFIG_COUNT".to_string(), config.len().to_string())];
    for (index, (key, value)) in config.into_iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{index}"), key.to_string()));
        env.push((format!("GIT_CONFIG_VALUE_{index}"), value));
    }
    env
}

/// Check, before serving, that this `git` applies the command-scope
/// configuration. A git older than 2.31 ignores `GIT_CONFIG_COUNT` and would
/// serve pushes without the shared hooks or object checks.
pub fn verify_backend_config(options: &GitHttpBackendOptions<'_>) -> anyhow::Result<()> {
    use anyhow::{bail, Context};

    let mut command = std::process::Command::new("git");
    command
        .args(["config", "--get", "core.hooksPath"])
        // Read no repository's config: the hooks directory is not one, and
        // discovery stops before the repo root.
        .current_dir(options.hooks_dir)
        .env("GIT_CEILING_DIRECTORIES", options.repo_root);
    for name in REMOVED_BACKEND_ENV {
        command.env_remove(name);
    }
    command.envs(backend_config_env(options));
    let output = command
        .output()
        .context("failed to run git to check the backend configuration")?;
    let applied = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || applied.trim_end_matches('\n') != options.hooks_dir {
        bail!(
            "git does not apply GIT_CONFIG_COUNT (git 2.31 or later is required); \
             core.hooksPath resolved to {:?}",
            applied.trim()
        );
    }
    Ok(())
}

pub async fn run_git_http_backend(
    options: &GitHttpBackendOptions<'_>,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: Body,
) -> Result<GitHttpBackendResponse, ServiceError> {
    let path = uri.path();
    let query = uri.query().unwrap_or("");

    let mut command = Command::new("git");
    command
        .arg("http-backend")
        .env("GIT_PROJECT_ROOT", options.repo_root)
        .env("GIT_HTTP_EXPORT_ALL", "1");
    for name in REMOVED_BACKEND_ENV {
        command.env_remove(name);
    }
    command.envs(backend_config_env(options));
    if let Some(push_report) = options.push_report {
        command.env(PUSH_REPORT_ENV, push_report);
    }
    if options.salvage_push {
        command.env(SALVAGE_PUSH_ENV, "1");
    }
    let mut child = command
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

    let (finished_tx, finished) = oneshot::channel();

    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                if !status.success() {
                    warn!(?status, "git http-backend exited with non-zero status");
                }
            }
            Err(error) => warn!(?error, "git http-backend wait failed"),
        }
        let _ = finished_tx.send(());
    });

    let mut response = Response::new(response_body);
    *response.status_mut() = status;
    *response.headers_mut() = headers_out;
    Ok(GitHttpBackendResponse { response, finished })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_config_pins_hooks_object_checks_and_push_size() {
        let options = GitHttpBackendOptions {
            repo_root: "/var/lib/instafy-git/repos",
            hooks_dir: "/var/lib/instafy-git/repos/.instafy-hooks",
            max_push_bytes: 4096,
            push_report: None,
            salvage_push: false,
        };
        assert_eq!(
            backend_config(&options),
            vec![
                (
                    "core.hooksPath",
                    "/var/lib/instafy-git/repos/.instafy-hooks".to_string()
                ),
                ("http.receivepack", "true".to_string()),
                ("receive.fsckObjects", "true".to_string()),
                ("transfer.fsckObjects", "true".to_string()),
                ("receive.maxInputSize", "4096".to_string()),
            ]
        );
        let env = backend_config_env(&options);
        assert_eq!(env[0], ("GIT_CONFIG_COUNT".to_string(), "5".to_string()));
        assert_eq!(
            env[1..3],
            [
                ("GIT_CONFIG_KEY_0".to_string(), "core.hooksPath".to_string()),
                (
                    "GIT_CONFIG_VALUE_0".to_string(),
                    "/var/lib/instafy-git/repos/.instafy-hooks".to_string()
                ),
            ]
        );
        assert_eq!(env.len(), 11);
    }

    #[test]
    fn installed_git_applies_the_backend_config() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "instafy-git-backend-config-{}-{nanos}",
            std::process::id()
        ));
        let hooks_dir = root.join(".instafy-hooks");
        std::fs::create_dir_all(&hooks_dir).unwrap();
        let (root_str, hooks_str) = (root.to_str().unwrap(), hooks_dir.to_str().unwrap());
        let options = GitHttpBackendOptions {
            repo_root: root_str,
            hooks_dir: hooks_str,
            max_push_bytes: 4096,
            push_report: None,
            salvage_push: false,
        };
        verify_backend_config(&options).expect("git applies GIT_CONFIG_COUNT");
        let _ = std::fs::remove_dir_all(&root);
    }
}
