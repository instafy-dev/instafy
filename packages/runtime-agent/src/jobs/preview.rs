use std::net::{TcpListener, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use serde_json::json;
use tokio::process::Command;
use tokio::time::sleep;
use uuid::Uuid;

use crate::model_environment::apply_allowlisted_tokio_environment;

use super::{CodexFileDescriptor, FileChangeDescriptor, JobMessage, JobMessageSender};

const DEFAULT_PREVIEW_PORT: u16 = 4173;
const PREVIEW_PORT_FALLBACK_RANGE: std::ops::RangeInclusive<u16> = 4173..=4180;
const LOGS_DIR_RELATIVE_PATH: &str = ".instafy/agent/logs";
const PREVIEW_SERVER_BIND: &str = "127.0.0.1";

#[derive(Debug, Clone)]
pub(super) struct FrontendPreviewResult {
    pub(super) public_url: String,
    pub(super) local_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelStateEntry {
    tunnel_id: String,
    project_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    hostname: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    local_port: u16,
}

fn tunnel_url_resolves(url: &str) -> bool {
    let parsed = match reqwest::Url::parse(url.trim()) {
        Ok(value) => value,
        Err(_) => return false,
    };

    let host = match parsed.host_str() {
        Some(value) if !value.trim().is_empty() => value.trim(),
        _ => return false,
    };
    let port = parsed.port_or_known_default().unwrap_or(443);
    (host, port)
        .to_socket_addrs()
        .map(|mut values| values.next().is_some())
        .unwrap_or(false)
}

fn tokenize_ascii(text: &str) -> Vec<&str> {
    text.split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect()
}

fn command_exists(program: &str) -> bool {
    if program.contains(std::path::MAIN_SEPARATOR) {
        return Path::new(program).exists();
    }

    let Some(path_value) = std::env::var_os("PATH") else {
        return false;
    };

    std::env::split_paths(&path_value).any(|dir| dir.join(program).exists())
}

fn resolve_python_server_binary() -> Option<&'static str> {
    if command_exists("python3") {
        Some("python3")
    } else if command_exists("python") {
        Some("python")
    } else {
        None
    }
}

fn build_preview_server_command(python_bin: &str, port: u16) -> String {
    format!("{python_bin} -m http.server {port} --bind {PREVIEW_SERVER_BIND}")
}

fn is_port_available(port: u16) -> bool {
    TcpListener::bind((PREVIEW_SERVER_BIND, port)).is_ok()
}

pub(super) fn is_frontend_preview_request(prompt_text: &str) -> bool {
    let normalized = prompt_text.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }

    let tokens = tokenize_ascii(&normalized);
    let wants_preview = [
        "preview", "browser", "share", "link", "tunnel", "public", "url",
    ]
    .iter()
    .any(|needle| tokens.iter().any(|token| token == needle));

    if wants_preview {
        return true;
    }

    let frontend_intent = [
        "landing", "page", "website", "site", "frontend", "react", "vite", "next", "ui", "app",
    ]
    .iter()
    .any(|needle| tokens.iter().any(|token| token == needle));

    let creation_intent = ["create", "build", "generate", "make", "scaffold"]
        .iter()
        .any(|needle| tokens.iter().any(|token| token == needle));

    frontend_intent && creation_intent
}

async fn try_fetch_local_html(port: u16, timeout: Duration) -> Result<bool> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .context("failed to build local preview http client")?;
    let url = format!("http://127.0.0.1:{port}");
    let response = match client.get(url).send().await {
        Ok(resp) => resp,
        Err(_) => return Ok(false),
    };
    Ok(response.status().is_success())
}

async fn ensure_preview_server_running(
    workspace_dir: &Path,
    port: u16,
    progress_sender: Option<&JobMessageSender>,
) -> Result<(i64, String, PathBuf, PathBuf)> {
    let local_url = format!("http://127.0.0.1:{port}");

    if try_fetch_local_html(port, Duration::from_millis(500))
        .await
        .unwrap_or(false)
    {
        return Ok((-1, local_url, PathBuf::new(), PathBuf::new()));
    }

    if !is_port_available(port) {
        return Err(anyhow!("Preview server port {port} is already in use."));
    }

    let python_bin = resolve_python_server_binary().ok_or_else(|| {
        anyhow!("Preview server requires `python3` (preferred) or `python` on PATH.")
    })?;
    let preview_command = build_preview_server_command(python_bin, port);

    let logs_dir = workspace_dir.join(LOGS_DIR_RELATIVE_PATH);
    tokio::fs::create_dir_all(&logs_dir)
        .await
        .with_context(|| format!("failed to create {}", logs_dir.display()))?;

    let stdout_path = logs_dir.join("web-preview.stdout.log");
    let stderr_path = logs_dir.join("web-preview.stderr.log");
    let stdout_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stdout_path)
        .with_context(|| format!("failed to open {}", stdout_path.display()))?;
    let stderr_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_path)
        .with_context(|| format!("failed to open {}", stderr_path.display()))?;

    let mut command = Command::new(python_bin);
    command
        .arg("-m")
        .arg("http.server")
        .arg(port.to_string())
        .arg("--bind")
        .arg(PREVIEW_SERVER_BIND)
        .current_dir(workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));
    apply_allowlisted_tokio_environment(&mut command, &[]);
    let child = command.spawn().context("failed to start preview server")?;

    let pid = child.id().map(|value| value as i64).unwrap_or(-1);

    if let Some(sender) = progress_sender {
        let _ = sender.send(JobMessage {
            content: preview_command.clone(),
            message_type: Some("command_execution".to_string()),
            metadata: Some(json!({
                "kind": "preview_server",
                "command": preview_command,
                "status": "started",
                "pid": pid,
            })),
        });
    }

    // Detach: let the server keep running beyond this job.
    drop(child);

    let mut ready = false;
    for _ in 0..20 {
        if try_fetch_local_html(port, Duration::from_millis(750))
            .await
            .unwrap_or(false)
        {
            ready = true;
            break;
        }
        sleep(Duration::from_millis(250)).await;
    }

    if !ready {
        if let Some(sender) = progress_sender {
            let _ = sender.send(JobMessage {
                content: build_preview_server_command(python_bin, port),
                message_type: Some("command_execution".to_string()),
                metadata: Some(json!({
                    "kind": "preview_server",
                    "command": build_preview_server_command(python_bin, port),
                    "status": "failed",
                    "pid": pid,
                })),
            });
        }
        return Err(anyhow!(
            "Preview server did not become ready on {local_url}. Check {}.",
            stderr_path.display()
        ));
    }

    if let Some(sender) = progress_sender {
        let _ = sender.send(JobMessage {
            content: build_preview_server_command(python_bin, port),
            message_type: Some("command_execution".to_string()),
            metadata: Some(json!({
                "kind": "preview_server",
                "command": build_preview_server_command(python_bin, port),
                "status": "completed",
                "pid": pid,
            })),
        });
    }

    Ok((pid, local_url, stdout_path, stderr_path))
}

async fn run_instafy_json(args: &[&str]) -> Result<serde_json::Value> {
    let output = Command::new("instafy")
        .args(args)
        .output()
        .await
        .with_context(|| format!("failed to execute instafy {}", args.join(" ")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let combined = if !stderr.is_empty() { stderr } else { stdout };
        return Err(anyhow!(
            "instafy {} failed (code={:?}): {}",
            args.join(" "),
            output.status.code(),
            combined
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).context("failed to parse instafy json output")
}

async fn ensure_tunnel_running(
    project_id: Uuid,
    port: u16,
    progress_sender: Option<&JobMessageSender>,
) -> Result<TunnelStateEntry> {
    let list_value = run_instafy_json(&["tunnel", "list", "--json"])
        .await
        .unwrap_or(json!([]));
    let existing: Vec<TunnelStateEntry> = serde_json::from_value(list_value).unwrap_or_default();

    if let Some(found) = existing.into_iter().find(|entry| {
        entry.project_id == project_id.to_string()
            && entry.local_port == port
            && !entry.url.trim().is_empty()
    }) {
        if tunnel_url_resolves(&found.url) {
            return Ok(found);
        }

        tracing::warn!(
            project_id = %project_id,
            tunnel_id = %found.tunnel_id,
            url = %found.url,
            "ignoring stale tunnel entry with unresolved hostname"
        );
    }

    if let Some(sender) = progress_sender {
        let _ = sender.send(JobMessage {
            content: format!("instafy tunnel start --port {port} --json"),
            message_type: Some("command_execution".to_string()),
            metadata: Some(json!({
                "kind": "preview_tunnel",
                "command": format!("instafy tunnel start --port {port} --json"),
                "status": "started",
            })),
        });
    }

    let started_value =
        run_instafy_json(&["tunnel", "start", "--port", &port.to_string(), "--json"]).await?;
    let started: TunnelStateEntry =
        serde_json::from_value(started_value).context("failed to parse tunnel start output")?;

    if let Some(sender) = progress_sender {
        let _ = sender.send(JobMessage {
            content: format!("instafy tunnel start --port {port} --json"),
            message_type: Some("command_execution".to_string()),
            metadata: Some(json!({
                "kind": "preview_tunnel",
                "command": format!("instafy tunnel start --port {port} --json"),
                "status": "completed",
                "tunnelId": started.tunnel_id,
                "url": started.url,
            })),
        });
    }

    Ok(started)
}

async fn ensure_index_html(workspace_dir: &Path) -> Result<Option<CodexFileDescriptor>> {
    let target_path = workspace_dir.join("index.html");
    if target_path.exists() {
        return Ok(None);
    }

    let html = r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Instafy Preview</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; }
      .hero { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 48px 20px; background: linear-gradient(135deg, #0ea5e9 0%, #a855f7 100%); color: white; }
      .card { width: min(900px, 100%); background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.25); border-radius: 20px; padding: 28px; backdrop-filter: blur(10px); }
      .kicker { opacity: 0.9; letter-spacing: 0.12em; text-transform: uppercase; font-size: 12px; margin: 0 0 8px; }
      h1 { font-size: 44px; line-height: 1.05; margin: 0 0 12px; }
      p { font-size: 18px; line-height: 1.6; margin: 0 0 18px; opacity: 0.95; }
      .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 10px; }
      .cta { display: inline-flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.45); background: rgba(15,23,42,0.35); color: white; text-decoration: none; font-weight: 600; }
      .cta:hover { background: rgba(15,23,42,0.5); }
      .pill { font-size: 13px; opacity: 0.9; padding: 8px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.35); background: rgba(255,255,255,0.10); }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import React from "https://esm.sh/react@18";
      import { createRoot } from "https://esm.sh/react-dom@18/client";

      function App() {
        return React.createElement(
          "main",
          { className: "hero" },
          React.createElement(
            "section",
            { className: "card" },
            React.createElement("p", { className: "kicker" }, "Preview"),
            React.createElement("h1", null, "Your landing page is live."),
            React.createElement(
              "p",
              null,
              "This is a lightweight Instafy preview (single-file React via CDN). Ask the assistant to customize the copy, add sections, or turn this into a full app."
            ),
            React.createElement(
              "div",
              { className: "row" },
              React.createElement(
                "a",
                {
                  className: "cta",
                  href: "#",
                  onclick: (e) => e.preventDefault()
                },
                "Customize this page"
              ),
              React.createElement("span", { className: "pill" }, "Port 4173"),
              React.createElement("span", { className: "pill" }, "Tunnel enabled")
            )
          )
        );
      }

      createRoot(document.getElementById("root")).render(React.createElement(App));
    </script>
  </body>
</html>
"##;

    tokio::fs::write(&target_path, html.as_bytes())
        .await
        .with_context(|| format!("failed to write {}", target_path.display()))?;

    Ok(Some(CodexFileDescriptor {
        path: "index.html".to_string(),
        workspace_path: "index.html".to_string(),
        label: Some("Landing page".to_string()),
        description: None,
        mime_type: Some("text/html".to_string()),
        content: None,
        content_base64: None,
        change: FileChangeDescriptor::parse(json!({ "type": "created" })),
    }))
}

pub(super) async fn maybe_attach_frontend_preview(
    project_id: Uuid,
    workspace_dir: &Path,
    prompt_text: &str,
    progress_sender: Option<&JobMessageSender>,
) -> Result<Option<(FrontendPreviewResult, Vec<CodexFileDescriptor>)>> {
    if !is_frontend_preview_request(prompt_text) {
        return Ok(None);
    }

    let mut selected_port: Option<u16> = None;
    let mut server_local_url: Option<String> = None;
    let mut last_error: Option<anyhow::Error> = None;
    for port in PREVIEW_PORT_FALLBACK_RANGE {
        match ensure_preview_server_running(workspace_dir, port, progress_sender).await {
            Ok((_server_pid, local_url, _stdout_path, _stderr_path)) => {
                selected_port = Some(port);
                server_local_url = Some(local_url);
                break;
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    let Some(port) = selected_port else {
        tracing::warn!(
            project_id = %project_id,
            default_port = DEFAULT_PREVIEW_PORT,
            "frontend preview server unavailable: {}",
            last_error
                .as_ref()
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown error".to_string())
        );
        return Ok(None);
    };

    let local_url = server_local_url.unwrap_or_else(|| format!("http://127.0.0.1:{port}"));

    let index_descriptor = ensure_index_html(workspace_dir).await?;

    let mut public_url = local_url.clone();
    match ensure_tunnel_running(project_id, port, progress_sender).await {
        Ok(value) => {
            public_url = value.url.trim().to_string();
        }
        Err(error) => {
            tracing::warn!(
                project_id = %project_id,
                port = port,
                "frontend preview tunnel unavailable: {error}"
            );
        }
    };

    let mut descriptors = Vec::new();
    if let Some(descriptor) = index_descriptor {
        descriptors.push(descriptor);
    }

    Ok(Some((
        FrontendPreviewResult {
            public_url: public_url.to_string(),
            local_url: local_url.to_string(),
        },
        descriptors,
    )))
}
