use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{JobExecution, JobMessage};

const MANIFEST_RELATIVE_PATH: &str = ".instafy/mcp/servers.json";
const CODEX_MANAGED_MCP_BLOCK_START: &str = "# instafy-managed-mcp-servers:start";
const CODEX_MANAGED_MCP_BLOCK_END: &str = "# instafy-managed-mcp-servers:end";
const DEFAULT_MCP_STARTUP_TIMEOUT_SEC: u64 = 45;
const DEFAULT_MCP_TOOL_TIMEOUT_SEC: u64 = 180;
const DEFAULT_MCP_REQUIRED: bool = false;
const MCP_ENDPOINT_PROBE_TIMEOUT_SECS: u64 = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpRequest {
    List,
    Install(McpInstallRequest),
    Remove { name: String },
    Help { reason: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpInstallRequest {
    pub source: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerInstallResult {
    pub name: String,
    pub url: String,
    pub source: String,
    pub changed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct McpManifest {
    #[serde(default)]
    servers: Vec<ManagedMcpServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManagedMcpServer {
    name: String,
    url: String,
    source: String,
}

impl ManagedMcpServer {
    fn normalized_name(&self) -> String {
        normalize_mcp_name(self.name.as_str()).unwrap_or_else(|| "mcp-server".to_string())
    }
}

pub fn parse_mcp_request(prompt_text: &str) -> Option<McpRequest> {
    let trimmed = prompt_text.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lowered = trimmed.to_ascii_lowercase();
    let command = if lowered.starts_with("/mcp") {
        "/mcp"
    } else if lowered.starts_with("/mcps") {
        "/mcps"
    } else {
        // Keep MCP handling explicit. Natural-language install/connect requests
        // must be interpreted by the model/skills and emitted as structured work.
        return None;
    };

    let rest = trimmed.strip_prefix(command).unwrap_or("").trim();
    if rest.is_empty() {
        return Some(McpRequest::List);
    }

    let mut parts = rest.split_whitespace();
    let subcommand_raw = parts.next().unwrap_or("");
    let subcommand = subcommand_raw.to_ascii_lowercase();
    match subcommand.as_str() {
        "list" | "ls" => Some(McpRequest::List),
        "install" | "add" => Some(parse_install_request(parts.collect())),
        "remove" | "rm" | "delete" => Some(parse_remove_request(parts.collect())),
        "help" => Some(McpRequest::Help { reason: None }),
        _ => Some(McpRequest::Help {
            reason: Some(format!("Unsupported MCP subcommand `{subcommand_raw}`.")),
        }),
    }
}

fn parse_install_request(tokens: Vec<&str>) -> McpRequest {
    if tokens.is_empty() {
        return McpRequest::Help {
            reason: Some("`/mcp install` requires a source URL.".to_string()),
        };
    }

    let source = tokens[0].trim();
    if source.is_empty() {
        return McpRequest::Help {
            reason: Some("`/mcp install` requires a source URL.".to_string()),
        };
    }

    let mut name: Option<String> = None;
    let mut index = 1usize;
    while index < tokens.len() {
        let token = tokens[index];
        if token.eq_ignore_ascii_case("--name") {
            if index + 1 >= tokens.len() {
                return McpRequest::Help {
                    reason: Some("`--name` requires a value.".to_string()),
                };
            }
            name = Some(tokens[index + 1].trim().to_string());
            index += 2;
            continue;
        }
        return McpRequest::Help {
            reason: Some(format!("Unsupported option `{token}` for `/mcp install`.")),
        };
    }

    McpRequest::Install(McpInstallRequest {
        source: source.to_string(),
        name,
    })
}

fn parse_remove_request(tokens: Vec<&str>) -> McpRequest {
    if tokens.is_empty() {
        return McpRequest::Help {
            reason: Some("`/mcp remove` requires a server name.".to_string()),
        };
    }
    let name = tokens[0].trim();
    if name.is_empty() {
        return McpRequest::Help {
            reason: Some("`/mcp remove` requires a server name.".to_string()),
        };
    }
    McpRequest::Remove {
        name: name.to_string(),
    }
}

pub async fn build_mcp_execution(request: McpRequest, workspace_dir: &Path) -> JobExecution {
    match request {
        McpRequest::List => build_list_execution(workspace_dir),
        McpRequest::Help { reason } => build_help_execution(reason),
        McpRequest::Remove { name } => build_remove_execution(workspace_dir, name),
        McpRequest::Install(request) => match install_mcp_server(workspace_dir, &request).await {
            Ok(result) => {
                let state_text = if result.changed {
                    "Installed"
                } else {
                    "Already installed"
                };
                JobExecution {
                    summary: format!(
                        "{state_text} MCP server `{}` at {}.",
                        result.name, result.url
                    ),
                    suggested_replies: vec![
                        "/mcp list".to_string(),
                        format!("Use {} to list interesting facts.", result.name),
                    ],
                    provider: "mcp".to_string(),
                    artifacts: vec![json!({
                        "kind": "mcp/install",
                        "mcpServer": {
                            "name": result.name,
                            "url": result.url,
                            "source": result.source,
                            "changed": result.changed,
                        }
                    })],
                    credit_snapshot: None,
                    provider_conversation_state: None,
                    messages: Vec::new(),
                    messages_streamed: false,
                    final_messages: vec![JobMessage {
                        content: format!(
                            "{state_text} MCP server `{}` ({}) for this project.",
                            result.name, result.url
                        ),
                        message_type: Some("command_execution".to_string()),
                        metadata: Some(json!({
                            "messageType": "command_execution",
                            "kind": "mcp_install",
                            "provider": "mcp",
                            "serverName": result.name,
                            "serverUrl": result.url,
                            "changed": result.changed,
                        })),
                    }],
                }
            }
            Err(error) => JobExecution {
                summary: format!("MCP install failed: {error}"),
                suggested_replies: vec![
                    "/mcp help".to_string(),
                    "Use /mcp install https://example.com/mcp --name example".to_string(),
                ],
                provider: "mcp".to_string(),
                artifacts: vec![],
                credit_snapshot: None,
                provider_conversation_state: None,
                messages: Vec::new(),
                messages_streamed: false,
                final_messages: vec![JobMessage {
                    content: format!("MCP install failed: {error}"),
                    message_type: Some("error".to_string()),
                    metadata: Some(json!({ "messageType": "error" })),
                }],
            },
        },
    }
}

pub fn sync_managed_mcp_servers(workspace_dir: &Path) -> Result<()> {
    let manifest = load_manifest(workspace_dir)?;
    render_manifest_to_codex_config(workspace_dir, &manifest)
}

fn build_list_execution(workspace_dir: &Path) -> JobExecution {
    match load_manifest(workspace_dir) {
        Ok(manifest) if manifest.servers.is_empty() => JobExecution {
            summary: "No MCP servers installed for this project.".to_string(),
            suggested_replies: vec![
                "/mcp install https://example.com/mcp --name example".to_string(),
                "/mcp help".to_string(),
            ],
            provider: "mcp".to_string(),
            artifacts: Vec::new(),
            credit_snapshot: None,
            provider_conversation_state: None,
            messages: Vec::new(),
            messages_streamed: false,
            final_messages: vec![JobMessage {
                content: "No MCP servers installed yet. Use `/mcp install <url> --name <server>`."
                    .to_string(),
                message_type: Some("command_execution".to_string()),
                metadata: Some(json!({
                    "messageType": "command_execution",
                    "kind": "mcp_list",
                    "count": 0,
                })),
            }],
        },
        Ok(manifest) => {
            let mut lines = vec![format!(
                "Installed MCP servers ({})",
                manifest.servers.len()
            )];
            for server in &manifest.servers {
                lines.push(format!("- {} → {}", server.name, server.url));
            }
            JobExecution {
                summary: format!("{} MCP server(s) installed.", manifest.servers.len()),
                suggested_replies: vec![
                    "Use datagouv to list interesting facts.".to_string(),
                    "/mcp remove datagouv".to_string(),
                ],
                provider: "mcp".to_string(),
                artifacts: vec![json!({
                    "kind": "mcp/list",
                    "servers": manifest.servers.iter().map(|server| json!({
                        "name": server.name,
                        "url": server.url,
                        "source": server.source,
                    })).collect::<Vec<_>>(),
                })],
                credit_snapshot: None,
                provider_conversation_state: None,
                messages: Vec::new(),
                messages_streamed: false,
                final_messages: vec![JobMessage {
                    content: lines.join("\n"),
                    message_type: Some("command_execution".to_string()),
                    metadata: Some(json!({
                        "messageType": "command_execution",
                        "kind": "mcp_list",
                        "count": manifest.servers.len(),
                    })),
                }],
            }
        }
        Err(error) => JobExecution {
            summary: format!("Failed to load MCP server list: {error}"),
            suggested_replies: vec!["/mcp help".to_string()],
            provider: "mcp".to_string(),
            artifacts: Vec::new(),
            credit_snapshot: None,
            provider_conversation_state: None,
            messages: Vec::new(),
            messages_streamed: false,
            final_messages: vec![JobMessage {
                content: format!("Failed to load MCP server list: {error}"),
                message_type: Some("error".to_string()),
                metadata: Some(json!({ "messageType": "error" })),
            }],
        },
    }
}

fn build_remove_execution(workspace_dir: &Path, raw_name: String) -> JobExecution {
    let normalized_name = match normalize_mcp_name(raw_name.as_str()) {
        Some(value) => value,
        None => {
            return build_help_execution(Some(format!("Invalid MCP server name `{}`.", raw_name)));
        }
    };

    match remove_mcp_server(workspace_dir, normalized_name.as_str()) {
        Ok(true) => JobExecution {
            summary: format!("Removed MCP server `{normalized_name}`."),
            suggested_replies: vec!["/mcp list".to_string()],
            provider: "mcp".to_string(),
            artifacts: Vec::new(),
            credit_snapshot: None,
            provider_conversation_state: None,
            messages: Vec::new(),
            messages_streamed: false,
            final_messages: vec![JobMessage {
                content: format!("Removed MCP server `{normalized_name}`."),
                message_type: Some("command_execution".to_string()),
                metadata: Some(json!({
                    "messageType": "command_execution",
                    "kind": "mcp_remove",
                    "serverName": normalized_name,
                })),
            }],
        },
        Ok(false) => JobExecution {
            summary: format!("MCP server `{normalized_name}` is not installed."),
            suggested_replies: vec!["/mcp list".to_string()],
            provider: "mcp".to_string(),
            artifacts: Vec::new(),
            credit_snapshot: None,
            provider_conversation_state: None,
            messages: Vec::new(),
            messages_streamed: false,
            final_messages: vec![JobMessage {
                content: format!("MCP server `{normalized_name}` is not installed."),
                message_type: Some("command_execution".to_string()),
                metadata: Some(json!({
                    "messageType": "command_execution",
                    "kind": "mcp_remove",
                    "serverName": normalized_name,
                    "removed": false,
                })),
            }],
        },
        Err(error) => JobExecution {
            summary: format!("Failed to remove MCP server: {error}"),
            suggested_replies: vec!["/mcp list".to_string(), "/mcp help".to_string()],
            provider: "mcp".to_string(),
            artifacts: Vec::new(),
            credit_snapshot: None,
            provider_conversation_state: None,
            messages: Vec::new(),
            messages_streamed: false,
            final_messages: vec![JobMessage {
                content: format!("Failed to remove MCP server: {error}"),
                message_type: Some("error".to_string()),
                metadata: Some(json!({ "messageType": "error" })),
            }],
        },
    }
}

fn build_help_execution(reason: Option<String>) -> JobExecution {
    let mut content = String::new();
    if let Some(reason) = reason {
        content.push_str(&reason);
        content.push_str("\n\n");
    }
    content.push_str(
        "MCP command usage:\n\
- `/mcp list`\n\
- `/mcp install <source> [--name <server-name>]`\n\
- `/mcp remove <server-name>`\n\n\
Supported install sources:\n\
- Direct MCP endpoint URL (for example `https://mcp.data.gouv.fr/mcp`)\n\
- GitHub repository URL (for example `https://github.com/datagouv/datagouv-mcp`), when README exposes an endpoint URL.",
    );

    JobExecution {
        summary: "MCP command help".to_string(),
        suggested_replies: vec![
            "/mcp install https://mcp.data.gouv.fr/mcp --name datagouv".to_string(),
            "/mcp list".to_string(),
        ],
        provider: "mcp".to_string(),
        artifacts: Vec::new(),
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: Vec::new(),
        messages_streamed: false,
        final_messages: vec![JobMessage {
            content,
            message_type: Some("command_execution".to_string()),
            metadata: Some(json!({
                "messageType": "command_execution",
                "kind": "mcp_help",
            })),
        }],
    }
}

async fn install_mcp_server(
    workspace_dir: &Path,
    request: &McpInstallRequest,
) -> Result<McpServerInstallResult> {
    let resolved = resolve_install_source(request).await?;
    validate_mcp_endpoint(resolved.url.as_str()).await?;
    let name = request
        .name
        .as_deref()
        .and_then(normalize_mcp_name)
        .or_else(|| normalize_mcp_name(resolved.name_hint.as_str()))
        .ok_or_else(|| anyhow!("unable to derive a valid MCP server name"))?;

    let mut manifest = load_manifest(workspace_dir)?;
    let matching_servers: Vec<&ManagedMcpServer> = manifest
        .servers
        .iter()
        .filter(|server| {
            server.normalized_name().eq_ignore_ascii_case(name.as_str())
                || server.url.eq_ignore_ascii_case(resolved.url.as_str())
        })
        .collect();
    let had_exact_match = matching_servers.iter().any(|server| {
        server.normalized_name().eq_ignore_ascii_case(name.as_str())
            && server.url == resolved.url
            && server.source == request.source
    });
    let had_alias_match = matching_servers.iter().any(|server| {
        !(server.normalized_name().eq_ignore_ascii_case(name.as_str())
            && server.url == resolved.url
            && server.source == request.source)
    });
    manifest.servers.retain(|server| {
        !(server.normalized_name().eq_ignore_ascii_case(name.as_str())
            || server.url.eq_ignore_ascii_case(resolved.url.as_str()))
    });
    manifest.servers.push(ManagedMcpServer {
        name: name.clone(),
        url: resolved.url.clone(),
        source: request.source.clone(),
    });
    let changed = !(had_exact_match && !had_alias_match);

    manifest.servers.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    persist_manifest(workspace_dir, &manifest)?;
    render_manifest_to_codex_config(workspace_dir, &manifest)?;

    Ok(McpServerInstallResult {
        name,
        url: resolved.url,
        source: request.source.clone(),
        changed,
    })
}

async fn validate_mcp_endpoint(endpoint_url: &str) -> Result<()> {
    let parsed =
        Url::parse(endpoint_url).context("resolved MCP endpoint URL is invalid during probe")?;
    let client = Client::builder()
        .timeout(Duration::from_secs(MCP_ENDPOINT_PROBE_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .context("failed to create HTTP client for MCP endpoint probe")?;

    let probe_payload = json!({
        "jsonrpc": "2.0",
        "id": "instafy-mcp-probe",
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "instafy-runtime-agent", "version": "0.1" }
        }
    });

    let response = client
        .post(parsed.clone())
        .header("user-agent", "instafy-runtime-agent/mcp")
        .header(
            "accept",
            "application/json, application/*+json, text/event-stream, application/x-ndjson, text/plain",
        )
        .json(&probe_payload)
        .send()
        .await
        .with_context(|| format!("failed to reach MCP endpoint `{endpoint_url}`"))?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let body_text = response.text().await.unwrap_or_default();
    let body_preview = summarize_probe_preview(body_text.as_str());
    let body_preview_lower = body_preview.to_ascii_lowercase();

    let looks_like_html = content_type.contains("text/html")
        || body_preview_lower.starts_with("<!doctype html")
        || body_preview_lower.starts_with("<html")
        || body_preview_lower.contains("<html");
    let looks_like_maintenance = body_preview_lower.contains("maintenance")
        || body_preview_lower.contains("temporarily unavailable")
        || body_preview_lower.contains("service unavailable")
        || body_preview_lower.contains("we're sorry")
        || body_preview_lower.contains("under maintenance");
    let looks_mcpish = content_type.contains("application/json")
        || content_type.contains("+json")
        || content_type.contains("text/event-stream")
        || content_type.contains("application/x-ndjson")
        || body_preview_lower.contains("jsonrpc")
        || body_preview_lower.contains("\"error\"")
        || body_preview_lower.contains("method not allowed");

    if looks_like_html || (content_type.starts_with("text/plain") && looks_like_maintenance) {
        bail!(
            "endpoint `{}` returned a non-MCP page (status {}, content-type `{}`): {}",
            endpoint_url,
            status.as_u16(),
            if content_type.is_empty() {
                "<none>"
            } else {
                content_type.as_str()
            },
            body_preview
        );
    }

    if status == StatusCode::NOT_FOUND {
        bail!(
            "endpoint `{}` returned 404 Not Found during MCP probe. Verify the MCP path (for example `/mcp`).",
            endpoint_url
        );
    }

    let acceptable_status = status.is_success()
        || matches!(
            status,
            StatusCode::BAD_REQUEST
                | StatusCode::UNAUTHORIZED
                | StatusCode::FORBIDDEN
                | StatusCode::METHOD_NOT_ALLOWED
                | StatusCode::NOT_ACCEPTABLE
                | StatusCode::UNPROCESSABLE_ENTITY
        );

    if !acceptable_status && !looks_mcpish {
        bail!(
            "endpoint `{}` did not respond like an MCP server (status {}, content-type `{}`): {}",
            endpoint_url,
            status.as_u16(),
            if content_type.is_empty() {
                "<none>"
            } else {
                content_type.as_str()
            },
            body_preview
        );
    }

    Ok(())
}

fn summarize_probe_preview(body: &str) -> String {
    let collapsed = body
        .replace('\r', " ")
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        "<empty body>".to_string()
    } else if trimmed.chars().count() > 220 {
        let preview: String = trimmed.chars().take(220).collect();
        format!("{preview}…")
    } else {
        trimmed.to_string()
    }
}

fn remove_mcp_server(workspace_dir: &Path, name: &str) -> Result<bool> {
    let mut manifest = load_manifest(workspace_dir)?;
    let before = manifest.servers.len();
    manifest
        .servers
        .retain(|server| !server.normalized_name().eq_ignore_ascii_case(name));
    let removed = before != manifest.servers.len();
    if removed {
        persist_manifest(workspace_dir, &manifest)?;
        render_manifest_to_codex_config(workspace_dir, &manifest)?;
    }
    Ok(removed)
}

#[derive(Debug, Clone)]
struct ResolvedInstallSource {
    url: String,
    name_hint: String,
}

async fn resolve_install_source(request: &McpInstallRequest) -> Result<ResolvedInstallSource> {
    let source = request.source.trim();
    if source.is_empty() {
        bail!("install source is empty");
    }
    let parsed = Url::parse(source).context("install source must be a valid URL")?;

    if is_github_repo_url(&parsed) {
        return resolve_github_repo_source(&parsed).await;
    }

    if is_mcp_endpoint_url(&parsed) {
        let name_hint = name_from_url_host(&parsed).unwrap_or_else(|| "mcp-server".to_string());
        return Ok(ResolvedInstallSource {
            url: parsed.to_string(),
            name_hint,
        });
    }

    bail!("unsupported MCP source URL. Provide a direct endpoint (…/mcp) or a GitHub repo URL.");
}

fn is_github_repo_url(url: &Url) -> bool {
    matches!(url.host_str(), Some("github.com" | "www.github.com"))
}

fn is_mcp_endpoint_url(url: &Url) -> bool {
    let path = url.path().to_ascii_lowercase();
    path.contains("/mcp")
}

fn name_from_url_host(url: &Url) -> Option<String> {
    let host = url.host_str()?.trim();
    if host.is_empty() {
        return None;
    }
    let base = host
        .split('.')
        .next()
        .map(str::to_string)
        .unwrap_or_else(|| host.to_string());
    normalize_mcp_name(base.as_str())
}

fn normalize_mcp_name(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in raw.chars() {
        let mapped = match ch {
            'a'..='z' | '0'..='9' => Some(ch),
            'A'..='Z' => Some(ch.to_ascii_lowercase()),
            '_' | '-' => Some('-'),
            _ => {
                pending_dash = true;
                None
            }
        };
        let Some(mapped) = mapped else {
            continue;
        };
        if mapped == '-' {
            pending_dash = false;
            if out.ends_with('-') || out.is_empty() {
                continue;
            }
            out.push('-');
            continue;
        }
        if pending_dash && !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        pending_dash = false;
        out.push(mapped);
    }
    let normalized = out.trim_matches('-').to_string();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

async fn resolve_github_repo_source(url: &Url) -> Result<ResolvedInstallSource> {
    let mut segments = url
        .path_segments()
        .ok_or_else(|| anyhow!("invalid GitHub repository URL path"))?;
    let owner = segments.next().unwrap_or("").trim();
    let repo = segments.next().unwrap_or("").trim();
    if owner.is_empty() || repo.is_empty() {
        bail!("GitHub source must be a repository URL like https://github.com/<owner>/<repo>");
    }

    let endpoint = discover_mcp_endpoint_from_github_repo(owner, repo).await?;
    let name_hint = normalize_mcp_name(repo).unwrap_or_else(|| "mcp-server".to_string());
    Ok(ResolvedInstallSource {
        url: endpoint,
        name_hint,
    })
}

async fn discover_mcp_endpoint_from_github_repo(owner: &str, repo: &str) -> Result<String> {
    let client = Client::builder()
        .build()
        .context("failed to create HTTP client")?;
    let readme_candidates = [
        format!("https://raw.githubusercontent.com/{owner}/{repo}/main/README.md"),
        format!("https://raw.githubusercontent.com/{owner}/{repo}/master/README.md"),
        format!("https://raw.githubusercontent.com/{owner}/{repo}/main/readme.md"),
        format!("https://raw.githubusercontent.com/{owner}/{repo}/master/readme.md"),
    ];

    for candidate in &readme_candidates {
        let response = client
            .get(candidate)
            .header("user-agent", "instafy-runtime-agent/mcp")
            .send()
            .await;
        let Ok(response) = response else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let body = response.text().await.unwrap_or_default();
        if let Some(url) = extract_first_mcp_url(body.as_str()) {
            return Ok(url);
        }
    }

    bail!(
        "could not discover an MCP endpoint from GitHub README. Provide a direct endpoint URL like `/mcp install https://example.com/mcp --name {repo}`."
    )
}

fn extract_first_mcp_url(text: &str) -> Option<String> {
    let mut candidate = String::new();
    let mut in_url = false;

    for ch in text.chars() {
        if !in_url {
            if ch == 'h' {
                candidate.clear();
                candidate.push(ch);
                in_url = true;
            }
            continue;
        }

        if ch.is_whitespace() || matches!(ch, ')' | ']' | '>' | '"' | '\'' | ',') {
            if let Some(parsed) = parse_mcp_url_candidate(candidate.as_str()) {
                return Some(parsed);
            }
            candidate.clear();
            in_url = false;
            continue;
        }
        candidate.push(ch);
    }

    parse_mcp_url_candidate(candidate.as_str())
}

fn parse_mcp_url_candidate(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return None;
    }
    let parsed = Url::parse(trimmed).ok()?;
    if !is_mcp_endpoint_url(&parsed) {
        return None;
    }
    Some(parsed.to_string())
}

fn manifest_path(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join(MANIFEST_RELATIVE_PATH)
}

fn load_manifest(workspace_dir: &Path) -> Result<McpManifest> {
    let path = manifest_path(workspace_dir);
    if !path.exists() {
        return Ok(McpManifest::default());
    }
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("failed to read MCP manifest {}", path.display()))?;
    let mut manifest: McpManifest =
        serde_json::from_str(raw.as_str()).context("failed to parse MCP manifest JSON")?;
    manifest
        .servers
        .retain(|server| normalize_mcp_name(server.name.as_str()).is_some());
    Ok(manifest)
}

fn persist_manifest(workspace_dir: &Path, manifest: &McpManifest) -> Result<()> {
    let path = manifest_path(workspace_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create MCP manifest directory {}",
                parent.display()
            )
        })?;
    }
    let bytes = serde_json::to_vec_pretty(manifest).context("failed to serialize MCP manifest")?;
    fs::write(&path, bytes)
        .with_context(|| format!("failed to write MCP manifest {}", path.display()))?;
    Ok(())
}

fn render_manifest_to_codex_config(workspace_dir: &Path, manifest: &McpManifest) -> Result<()> {
    let codex_home = std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_dir.join(".codex"));
    fs::create_dir_all(&codex_home)
        .with_context(|| format!("failed to create CODEX_HOME {}", codex_home.display()))?;
    let config_path = codex_home.join("config.toml");

    let existing = fs::read_to_string(&config_path).unwrap_or_default();
    let without_managed_block = strip_managed_mcp_block(existing.as_str());
    let sanitized = sanitize_codex_config_for_managed_mcp(without_managed_block.as_str());
    let managed_names: HashSet<String> = manifest
        .servers
        .iter()
        .map(ManagedMcpServer::normalized_name)
        .collect();
    let sanitized_without_managed_names =
        strip_mcp_server_blocks(sanitized.as_str(), &managed_names);
    let mut output = sanitized_without_managed_names.trim_end().to_string();

    if !manifest.servers.is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push('\n');
        output.push_str(CODEX_MANAGED_MCP_BLOCK_START);
        output.push('\n');
        for server in &manifest.servers {
            let name = server.normalized_name();
            output.push_str(&format!("[mcp_servers.{name}]\n"));
            output.push_str(&format!(
                "url = \"{}\"\n",
                escape_toml_string(server.url.as_str())
            ));
            output.push_str(&format!(
                "required = {}\n",
                if DEFAULT_MCP_REQUIRED {
                    "true"
                } else {
                    "false"
                }
            ));
            output.push_str(&format!(
                "startup_timeout_sec = {DEFAULT_MCP_STARTUP_TIMEOUT_SEC}\n"
            ));
            output.push_str(&format!(
                "tool_timeout_sec = {DEFAULT_MCP_TOOL_TIMEOUT_SEC}\n"
            ));
            output.push('\n');
        }
        output.push_str(CODEX_MANAGED_MCP_BLOCK_END);
        output.push('\n');
    } else if !output.is_empty() {
        output.push('\n');
    }

    if output != existing {
        fs::write(&config_path, output.as_bytes())
            .with_context(|| format!("failed to write CODEX config {}", config_path.display()))?;
    }

    Ok(())
}

fn sanitize_codex_config_for_managed_mcp(existing: &str) -> String {
    let lines: Vec<&str> = existing.lines().collect();
    let mut retained_lines: Vec<String> = Vec::with_capacity(lines.len());
    let mut index = 0usize;
    let mut seen_mcp_blocks: HashSet<String> = HashSet::new();
    let mut seen_rmcp_setting = false;

    while index < lines.len() {
        let current = lines[index];
        let trimmed = current.trim();
        let stripped = trimmed.split('#').next().unwrap_or("").trim();

        if stripped.starts_with("experimental_use_rmcp_client") {
            if !seen_rmcp_setting {
                retained_lines.push(current.to_string());
                seen_rmcp_setting = true;
            }
            index += 1;
            continue;
        }

        if let Some(server_name) = parse_mcp_server_header(stripped) {
            let block_start = index;
            index += 1;
            while index < lines.len() {
                let next = lines[index].trim();
                let next_stripped = next.split('#').next().unwrap_or("").trim();
                if next_stripped.starts_with('[') {
                    break;
                }
                index += 1;
            }

            if !seen_mcp_blocks.insert(server_name.to_string()) {
                continue;
            }
            retained_lines.extend(
                lines[block_start..index]
                    .iter()
                    .map(|line| (*line).to_string()),
            );
            continue;
        }

        retained_lines.push(current.to_string());
        index += 1;
    }

    let mut compacted = Vec::with_capacity(retained_lines.len());
    let mut previous_blank = false;
    for line in retained_lines {
        let is_blank = line.trim().is_empty();
        if is_blank && previous_blank {
            continue;
        }
        compacted.push(line);
        previous_blank = is_blank;
    }
    while compacted
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        compacted.pop();
    }
    compacted.join("\n")
}

fn strip_managed_mcp_block(existing: &str) -> String {
    let mut lines = Vec::new();
    let mut in_block = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == CODEX_MANAGED_MCP_BLOCK_START {
            in_block = true;
            continue;
        }
        if trimmed == CODEX_MANAGED_MCP_BLOCK_END {
            in_block = false;
            continue;
        }
        if !in_block {
            lines.push(line.to_string());
        }
    }
    let mut compacted = Vec::with_capacity(lines.len());
    let mut previous_blank = false;
    for line in lines {
        let is_blank = line.trim().is_empty();
        if is_blank && previous_blank {
            continue;
        }
        compacted.push(line);
        previous_blank = is_blank;
    }
    while compacted
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        compacted.pop();
    }
    compacted.join("\n")
}

fn parse_mcp_server_header(stripped: &str) -> Option<&str> {
    if !stripped.starts_with("[mcp_servers.") || !stripped.ends_with(']') {
        return None;
    }
    let inner = &stripped["[mcp_servers.".len()..stripped.len() - 1];
    if inner.is_empty() {
        return None;
    }
    Some(inner)
}

fn strip_mcp_server_blocks(existing: &str, names_to_strip: &HashSet<String>) -> String {
    if names_to_strip.is_empty() {
        return existing.to_string();
    }

    let lines: Vec<&str> = existing.lines().collect();
    let mut output: Vec<String> = Vec::with_capacity(lines.len());
    let mut index = 0usize;

    while index < lines.len() {
        let current = lines[index];
        let stripped = current.trim().split('#').next().unwrap_or("").trim();

        if let Some(server_name) = parse_mcp_server_header(stripped) {
            let block_start = index;
            index += 1;
            while index < lines.len() {
                let next_stripped = lines[index].trim().split('#').next().unwrap_or("").trim();
                if next_stripped.starts_with('[') {
                    break;
                }
                index += 1;
            }

            if names_to_strip.contains(server_name) {
                continue;
            }
            output.extend(
                lines[block_start..index]
                    .iter()
                    .map(|line| (*line).to_string()),
            );
            continue;
        }

        output.push(current.to_string());
        index += 1;
    }

    let mut compacted = Vec::with_capacity(output.len());
    let mut previous_blank = false;
    for line in output {
        let is_blank = line.trim().is_empty();
        if is_blank && previous_blank {
            continue;
        }
        compacted.push(line);
        previous_blank = is_blank;
    }
    while compacted
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        compacted.pop();
    }
    compacted.join("\n")
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::{
        CODEX_MANAGED_MCP_BLOCK_END, CODEX_MANAGED_MCP_BLOCK_START, McpInstallRequest, McpRequest,
        build_mcp_execution, install_mcp_server, parse_mcp_request, strip_managed_mcp_block,
    };
    use axum::{Router, http::StatusCode, routing::post};
    use tempfile::tempdir;

    async fn spawn_mock_mcp_endpoint(
        status: StatusCode,
        content_type: &'static str,
        body: &'static str,
    ) -> String {
        let app = Router::new().route(
            "/mcp",
            post(move || async move { (status, [("content-type", content_type)], body) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock endpoint");
        let addr = listener.local_addr().expect("mock endpoint addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}/mcp")
    }

    #[test]
    fn parse_mcp_request_supports_install_remove_list() {
        let parsed = parse_mcp_request("/mcp install https://mcp.data.gouv.fr/mcp --name datagouv");
        match parsed {
            Some(McpRequest::Install(request)) => {
                assert_eq!(request.source, "https://mcp.data.gouv.fr/mcp");
                assert_eq!(request.name.as_deref(), Some("datagouv"));
            }
            other => panic!("expected install request, got {other:?}"),
        }

        assert!(matches!(
            parse_mcp_request("/mcp list"),
            Some(McpRequest::List)
        ));
        assert!(matches!(
            parse_mcp_request("/mcp remove datagouv"),
            Some(McpRequest::Remove { .. })
        ));
    }

    #[test]
    fn strip_managed_block_removes_only_mcp_managed_segment() {
        let text = format!(
            "foo = 1\n\n{CODEX_MANAGED_MCP_BLOCK_START}\n[mcp_servers.x]\nurl = \"https://example.com/mcp\"\n{CODEX_MANAGED_MCP_BLOCK_END}\n\nbar = 2\n"
        );
        let stripped = strip_managed_mcp_block(text.as_str());
        assert_eq!(stripped, "foo = 1\n\nbar = 2");
    }

    #[test]
    fn sanitize_codex_config_for_managed_mcp_dedupes_rmcp_and_mcp_blocks() {
        let text = r#"
experimental_use_rmcp_client = true
experimental_use_rmcp_client = true

[mcp_servers.datagouv]
url = "https://example.com/mcp"
required = false

[mcp_servers.datagouv]
url = "https://example.com/mcp"
required = true
"#;

        let sanitized = super::sanitize_codex_config_for_managed_mcp(text);
        assert_eq!(
            sanitized
                .lines()
                .filter(|line| line.trim().starts_with("experimental_use_rmcp_client"))
                .count(),
            1
        );
        assert_eq!(sanitized.matches("[mcp_servers.datagouv]").count(), 1);
        assert!(sanitized.contains("required = false"));
        assert!(!sanitized.contains("required = true"));
    }

    #[test]
    fn sanitize_codex_config_for_managed_mcp_dedupes_generic_mcp_servers() {
        let text = r#"
[mcp_servers.datagouv]
url = "https://mcp.data.gouv.fr/mcp"

[mcp_servers.datagouv]
url = "https://mcp.data.gouv.fr/mcp"
"#;

        let sanitized = super::sanitize_codex_config_for_managed_mcp(text);
        assert_eq!(sanitized.matches("[mcp_servers.datagouv]").count(), 1);
    }

    #[tokio::test]
    async fn install_mcp_server_direct_endpoint_writes_manifest_and_codex_config() {
        let workspace_dir = tempdir().expect("tempdir");
        let codex_home = workspace_dir.path().join(".codex");
        std::fs::create_dir_all(&codex_home).expect("codex home");
        let endpoint_url = spawn_mock_mcp_endpoint(
            StatusCode::BAD_REQUEST,
            "application/json",
            r#"{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request"}}"#,
        )
        .await;
        std::fs::write(
            codex_home.join("config.toml"),
            r#"
experimental_use_rmcp_client = true
experimental_use_rmcp_client = true

[mcp_servers.datagouv]
url = "https://stale.example/mcp"
required = false

[mcp_servers.datagouv]
url = "https://stale.example/mcp"
required = true
"#,
        )
        .expect("seed duplicate config");

        let request = McpInstallRequest {
            source: endpoint_url.clone(),
            name: Some("Datagouv".to_string()),
        };

        let result = install_mcp_server(workspace_dir.path(), &request)
            .await
            .expect("install should succeed");
        assert_eq!(result.name, "datagouv");
        assert_eq!(result.url, endpoint_url);

        let manifest_path = workspace_dir.path().join(".instafy/mcp/servers.json");
        let manifest = std::fs::read_to_string(&manifest_path).expect("manifest should exist");
        assert!(manifest.contains("\"name\": \"datagouv\""));
        assert!(manifest.contains(&format!("\"url\": \"{}\"", result.url)));

        let config_path = workspace_dir.path().join(".codex/config.toml");
        let config = std::fs::read_to_string(&config_path).expect("codex config should exist");
        assert!(config.contains("[mcp_servers.datagouv]"));
        assert!(config.contains(&format!("url = \"{}\"", result.url)));
        assert_eq!(config.matches("[mcp_servers.datagouv]").count(), 1);
        assert!(config.contains("required = false"));
        assert_eq!(
            config
                .lines()
                .filter(|line| line.trim().starts_with("experimental_use_rmcp_client"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn install_mcp_server_dedupes_name_aliases_for_same_endpoint() {
        let workspace_dir = tempdir().expect("tempdir");
        let endpoint_url = spawn_mock_mcp_endpoint(
            StatusCode::BAD_REQUEST,
            "application/json",
            r#"{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request"}}"#,
        )
        .await;
        let manifest_dir = workspace_dir.path().join(".instafy/mcp");
        std::fs::create_dir_all(&manifest_dir).expect("manifest dir");
        let seeded_manifest = serde_json::json!({
            "servers": [
                {
                    "name": "datagouv",
                    "url": endpoint_url,
                    "source": "https://github.com/datagouv/datagouv-mcp"
                },
                {
                    "name": "datagouv-mcp",
                    "url": endpoint_url,
                    "source": "https://github.com/datagouv/datagouv-mcp"
                }
            ]
        });
        std::fs::write(
            manifest_dir.join("servers.json"),
            serde_json::to_vec_pretty(&seeded_manifest).expect("serialize seed manifest"),
        )
        .expect("seed manifest");
        std::fs::create_dir_all(workspace_dir.path().join(".codex")).expect("codex home");

        let request = McpInstallRequest {
            source: endpoint_url.clone(),
            name: Some("datagouv".to_string()),
        };
        let result = install_mcp_server(workspace_dir.path(), &request)
            .await
            .expect("install should succeed");
        assert_eq!(result.name, "datagouv");
        assert!(result.changed);

        let manifest =
            std::fs::read_to_string(workspace_dir.path().join(".instafy/mcp/servers.json"))
                .expect("manifest should exist");
        assert_eq!(
            manifest
                .matches(format!("\"url\": \"{endpoint_url}\"").as_str())
                .count(),
            1
        );
        assert_eq!(manifest.matches("\"name\": \"datagouv\"").count(), 1);
        assert!(!manifest.contains("\"name\": \"datagouv-mcp\""));
    }

    #[tokio::test]
    async fn mcp_install_emits_command_execution_message_type() {
        let workspace_dir = tempdir().expect("tempdir");
        let endpoint_url = spawn_mock_mcp_endpoint(
            StatusCode::BAD_REQUEST,
            "application/json",
            r#"{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request"}}"#,
        )
        .await;
        let execution = build_mcp_execution(
            McpRequest::Install(McpInstallRequest {
                source: endpoint_url,
                name: Some("datagouv".to_string()),
            }),
            workspace_dir.path(),
        )
        .await;

        assert_eq!(execution.provider, "mcp");
        let message = execution
            .final_messages
            .first()
            .expect("install should emit a final message");
        assert_eq!(message.message_type.as_deref(), Some("command_execution"));
        let metadata = message.metadata.as_ref().expect("metadata should exist");
        assert_eq!(
            metadata.get("messageType").and_then(|value| value.as_str()),
            Some("command_execution")
        );
        assert_eq!(
            metadata.get("kind").and_then(|value| value.as_str()),
            Some("mcp_install")
        );
    }

    #[tokio::test]
    async fn install_mcp_server_rejects_html_maintenance_pages() {
        let workspace_dir = tempdir().expect("tempdir");
        let endpoint_url = spawn_mock_mcp_endpoint(
            StatusCode::OK,
            "text/html; charset=utf-8",
            "<!doctype html><html><body>Sorry, service under maintenance.</body></html>",
        )
        .await;
        let request = McpInstallRequest {
            source: endpoint_url.clone(),
            name: Some("datagouv".to_string()),
        };

        let error = install_mcp_server(workspace_dir.path(), &request)
            .await
            .expect_err("html maintenance endpoint should be rejected");
        let error_text = error.to_string().to_ascii_lowercase();
        assert!(error_text.contains("non-mcp page"));
        assert!(error_text.contains(endpoint_url.as_str()));
    }
}
