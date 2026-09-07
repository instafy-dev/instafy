use std::borrow::Cow;
use std::collections::HashMap;
use std::ffi::OsString;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use rmcp::ErrorData as McpError;
use rmcp::ServiceExt;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use serde_json::{Map as JsonMap, Value as JsonValue, json};
use tokio::process::Child;
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{Duration, sleep};

use crate::model_environment::apply_allowlisted_tokio_environment;

pub const ENABLED_ENV: &str = "INSTAFY_LOCAL_BROWSER_ENABLED";
pub const PLAYWRIGHT_PATH_ENV: &str = "INSTAFY_LOCAL_BROWSER_PLAYWRIGHT_PATH";
pub const CHROMIUM_PATH_ENV: &str = "INSTAFY_LOCAL_BROWSER_CHROMIUM_PATH";
pub const EGRESS_PROXY_PATH_ENV: &str = "INSTAFY_LOCAL_BROWSER_EGRESS_PROXY_PATH";
pub const NODE_PATH_ENV: &str = "INSTAFY_LOCAL_BROWSER_NODE_PATH";
pub const WORKSPACE_PATH_ENV: &str = "INSTAFY_LOCAL_BROWSER_WORKSPACE_DIR";
const PROXY_URL_ENV: &str = "INSTAFY_LOCAL_BROWSER_PROXY_URL";
pub const MCP_COMMAND: &str = "local-browser-mcp";
pub const MCP_SERVER_NAME: &str = "instafy_local_browser";
#[cfg(target_os = "linux")]
const MCP_SELF_EXE_PATH: &str = "/proc/self/exe";

const OBSERVER_SCRIPT: &str = include_str!("../assets/local-browser-observe.js");
const MAX_URL_CHARS: usize = 4_096;
const MAX_OBSERVATIONS: usize = 24;
const MAX_NAME_CHARS: usize = 80;
const MAX_SELECTOR_CHARS: usize = 512;
const MAX_STYLE_PROPERTIES: usize = 16;
const MAX_STYLE_NAME_CHARS: usize = 64;
const MAX_SCREENSHOT_PATH_CHARS: usize = 240;
const MAX_SCREENSHOT_BYTES: usize = 32 * 1024 * 1024;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
#[cfg(target_os = "linux")]
const MAX_TRUSTED_TREE_ENTRIES: usize = 50_000;

static PROCESS_CONFIG: OnceLock<std::result::Result<Option<LocalBrowserConfig>, String>> =
    OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalBrowserConfig {
    pub node_path: PathBuf,
    pub playwright_path: PathBuf,
    pub chromium_path: PathBuf,
    pub egress_proxy_path: PathBuf,
}

#[derive(Debug, Clone)]
struct LocalBrowserRequest {
    payload: JsonValue,
    screenshot_path: Option<String>,
}

pub fn process_config() -> Result<Option<LocalBrowserConfig>> {
    match PROCESS_CONFIG.get_or_init(|| {
        local_browser_config_from_reader(|key| std::env::var_os(key))
            .map_err(|error| error.to_string())
    }) {
        Ok(config) => Ok(config.clone()),
        Err(error) => Err(anyhow!(error.clone())),
    }
}

pub fn registration_capability() -> Option<JsonValue> {
    match process_config() {
        Ok(Some(_)) => Some(capability_value()),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(error = %error, "owner-local browser capability is disabled");
            None
        }
    }
}

fn capability_value() -> JsonValue {
    json!({
        "enabled": true,
        "mode": "read-only-headless",
        "networkPolicy": "public-http-only",
        "computedStyles": true,
        "screenshots": true,
        "tools": ["observe"]
    })
}

fn local_browser_config_from_reader(
    read: impl FnMut(&str) -> Option<OsString>,
) -> Result<Option<LocalBrowserConfig>> {
    local_browser_config_from_reader_with_trust(read, validate_local_browser_dependency_trust)
}

fn local_browser_config_from_reader_with_trust(
    mut read: impl FnMut(&str) -> Option<OsString>,
    validate_trust: impl FnOnce(&LocalBrowserConfig) -> Result<()>,
) -> Result<Option<LocalBrowserConfig>> {
    let enabled = match read(ENABLED_ENV) {
        None => false,
        Some(value) => {
            let value = value
                .into_string()
                .map_err(|_| anyhow!("{ENABLED_ENV} must contain Unicode text"))?;
            match value.trim().to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => true,
                "0" | "false" | "no" | "off" => false,
                _ => bail!("{ENABLED_ENV} must be one of 1, true, yes, on, 0, false, no, or off"),
            }
        }
    };
    if !enabled {
        return Ok(None);
    }

    let Some(playwright_path) = read(PLAYWRIGHT_PATH_ENV).map(PathBuf::from) else {
        bail!("{PLAYWRIGHT_PATH_ENV} is required when {ENABLED_ENV}=1");
    };
    let Some(chromium_path) = read(CHROMIUM_PATH_ENV).map(PathBuf::from) else {
        bail!("{CHROMIUM_PATH_ENV} is required when {ENABLED_ENV}=1");
    };
    let Some(egress_proxy_path) = read(EGRESS_PROXY_PATH_ENV).map(PathBuf::from) else {
        bail!("{EGRESS_PROXY_PATH_ENV} is required when {ENABLED_ENV}=1");
    };
    let node_path = match read(NODE_PATH_ENV).map(PathBuf::from) {
        Some(path) => validate_executable(path, NODE_PATH_ENV)?,
        None => resolve_path_executable("node")
            .context("node is required when owner-local browser automation is enabled")?,
    };
    let playwright_path = validate_playwright_path(playwright_path)?;
    let chromium_path = validate_executable(chromium_path, CHROMIUM_PATH_ENV)?;
    let egress_proxy_path = validate_executable(egress_proxy_path, EGRESS_PROXY_PATH_ENV)?;
    let config = LocalBrowserConfig {
        node_path,
        playwright_path,
        chromium_path,
        egress_proxy_path,
    };
    validate_trust(&config)?;
    Ok(Some(config))
}

#[cfg(target_os = "linux")]
fn validate_local_browser_dependency_trust(config: &LocalBrowserConfig) -> Result<()> {
    // These checks exclude direct mutation by the current unprivileged identity. They cannot
    // discover sudo policy, root-equivalent service sockets, or other host escalation paths; an
    // ordinary self-hosted runtime still trusts its owner/model process at that broader boundary.
    // SAFETY: geteuid has no preconditions and does not dereference memory.
    if unsafe { libc::geteuid() } == 0 {
        bail!("owner-local browser observation requires an unprivileged runtime user");
    }
    let process_status = std::fs::read_to_string("/proc/self/status")
        .context("owner-local browser observation requires Linux process capability metadata")?;
    validate_unprivileged_linux_identity(&process_status)?;
    validate_zero_linux_capability_masks(&process_status)?;
    validate_root_owned_path(&config.node_path, NODE_PATH_ENV)?;
    validate_root_owned_tree(&config.playwright_path, PLAYWRIGHT_PATH_ENV)?;
    validate_root_owned_path(&config.chromium_path, CHROMIUM_PATH_ENV)?;
    let chromium_directory = config
        .chromium_path
        .parent()
        .context("configured Chromium executable has no containing directory")?;
    validate_root_owned_tree(chromium_directory, CHROMIUM_PATH_ENV)?;
    validate_root_owned_path(&config.egress_proxy_path, EGRESS_PROXY_PATH_ENV)?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn validate_local_browser_dependency_trust(_config: &LocalBrowserConfig) -> Result<()> {
    bail!("owner-local browser observation is currently supported only on Linux")
}

#[cfg(any(target_os = "linux", test))]
fn validate_unprivileged_linux_identity(status: &str) -> Result<()> {
    let values = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .context("Linux process metadata omitted Uid")?
        .split_whitespace()
        .map(str::parse::<u32>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("Linux process metadata contained an invalid Uid")?;
    if values.len() != 4 || values.contains(&0) {
        bail!(
            "owner-local browser observation requires non-root real/effective/saved/filesystem UIDs"
        );
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn validate_zero_linux_capability_masks(status: &str) -> Result<()> {
    for name in ["CapInh", "CapPrm", "CapEff", "CapAmb"] {
        let prefix = format!("{name}:");
        let value = status
            .lines()
            .find_map(|line| line.strip_prefix(&prefix))
            .with_context(|| format!("Linux process metadata omitted {name}"))?
            .trim();
        let mask = u128::from_str_radix(value, 16)
            .with_context(|| format!("Linux process metadata contained invalid {name}"))?;
        if mask != 0 {
            bail!("owner-local browser observation requires an empty Linux {name} mask");
        }
    }
    Ok(())
}

pub fn mcp_executable() -> Result<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let executable = PathBuf::from(MCP_SELF_EXE_PATH);
        let metadata = std::fs::metadata(&executable)
            .context("failed to inspect the running runtime-agent image through /proc/self/exe")?;
        if !metadata.is_file() {
            bail!("/proc/self/exe does not reference a regular runtime-agent image");
        }
        // Keep this magic-link path literal. Canonicalizing it would turn it back into the
        // mutable installation pathname and reintroduce a replacement race between turns.
        return Ok(executable);
    }

    #[cfg(not(target_os = "linux"))]
    bail!("owner-local browser MCP re-exec is currently supported only on Linux")
}

#[cfg(target_os = "linux")]
fn validate_root_owned_path(path: &Path, name: &str) -> Result<()> {
    for component in path.ancestors() {
        let metadata = std::fs::symlink_metadata(component)
            .with_context(|| format!("failed to inspect trusted path for {name}"))?;
        validate_root_owned_metadata(component, &metadata, name)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_root_owned_tree(root: &Path, name: &str) -> Result<()> {
    validate_root_owned_path(root, name)?;
    let mut pending = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .with_context(|| format!("failed to inspect trusted dependency tree for {name}"))?
        {
            let path = entry
                .with_context(|| format!("failed to inspect trusted dependency tree for {name}"))?
                .path();
            visited = visited
                .checked_add(1)
                .context("trusted dependency tree entry count overflowed")?;
            if visited > MAX_TRUSTED_TREE_ENTRIES {
                bail!(
                    "trusted dependency tree for {name} exceeds {MAX_TRUSTED_TREE_ENTRIES} entries"
                );
            }
            let metadata = std::fs::symlink_metadata(&path)
                .with_context(|| format!("failed to inspect trusted dependency for {name}"))?;
            validate_root_owned_metadata(&path, &metadata, name)?;
            if metadata.is_dir() {
                pending.push(path);
            } else if !metadata.is_file() {
                bail!("trusted dependency tree for {name} contains a non-file entry");
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_root_owned_metadata(
    path: &Path,
    metadata: &std::fs::Metadata,
    name: &str,
) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    if metadata.file_type().is_symlink() {
        bail!("trusted dependency path for {name} cannot contain symlinks");
    }
    if metadata.uid() != 0 {
        bail!(
            "trusted dependency path for {name} must be root-owned: {}",
            path.display()
        );
    }
    if metadata.mode() & 0o022 != 0 {
        bail!(
            "trusted dependency path for {name} must not be group- or world-writable: {}",
            path.display()
        );
    }
    Ok(())
}

fn validate_playwright_path(path: PathBuf) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("{PLAYWRIGHT_PATH_ENV} must be an absolute path");
    }
    let canonical = std::fs::canonicalize(&path)
        .with_context(|| format!("failed to resolve {PLAYWRIGHT_PATH_ENV}"))?;
    if !canonical.is_dir() || !canonical.join("package.json").is_file() {
        bail!("{PLAYWRIGHT_PATH_ENV} must name an installed Playwright package directory");
    }
    Ok(canonical)
}

fn validate_executable(path: PathBuf, name: &str) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("{name} must be an absolute path");
    }
    let canonical =
        std::fs::canonicalize(&path).with_context(|| format!("failed to resolve {name}"))?;
    let metadata = canonical
        .metadata()
        .with_context(|| format!("failed to inspect {name}"))?;
    if !metadata.is_file() {
        bail!("{name} must name a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            bail!("{name} must name an executable file");
        }
    }
    Ok(canonical)
}

fn resolve_path_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|directory| [directory.join(name), directory.join(format!("{name}.exe"))])
        .find_map(|candidate| validate_executable(candidate, NODE_PATH_ENV).ok())
}

pub fn is_mcp_command(args: &[OsString]) -> bool {
    args.first().is_some_and(|value| value == MCP_COMMAND)
}

pub async fn run_mcp_stdio() -> Result<()> {
    let config = process_config()?.context("owner-local browser capability is unavailable")?;
    let workspace = std::env::var_os(WORKSPACE_PATH_ENV)
        .map(PathBuf::from)
        .context("owner-local browser MCP is missing its workspace capability")?;
    if !workspace.is_absolute() || !workspace.is_dir() {
        bail!("owner-local browser MCP workspace must be an existing absolute directory");
    }
    let running = LocalBrowserMcpServer::new(config, workspace)
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await
        .context("failed to start the owner-local browser MCP server")?;
    running
        .waiting()
        .await
        .context("owner-local browser MCP transport failed")?;
    Ok(())
}

#[derive(Clone)]
struct LocalBrowserMcpServer {
    config: LocalBrowserConfig,
    workspace: PathBuf,
    tools: Arc<Vec<Tool>>,
    execution_lock: Arc<AsyncMutex<()>>,
}

impl LocalBrowserMcpServer {
    fn new(config: LocalBrowserConfig, workspace: PathBuf) -> Self {
        Self {
            config,
            workspace,
            tools: Arc::new(local_browser_tools()),
            execution_lock: Arc::new(AsyncMutex::new(())),
        }
    }
}

impl ServerHandler for LocalBrowserMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Observe a public HTTP(S) page in a fresh owner-local headless browser. This capability is read-only and has no saved login state.",
        )
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output = std::result::Result<ListToolsResult, McpError>> + Send + '_
    {
        let tools = self.tools.clone();
        async move { Ok(ListToolsResult::with_all_items((*tools).clone())) }
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> std::result::Result<CallToolResponse, McpError> {
        if request.name.as_ref() != "observe" {
            return Err(McpError::invalid_params(
                "unknown owner-local browser tool",
                None,
            ));
        }
        let parsed = parse_observe_request(request.arguments)
            .map_err(|error| McpError::invalid_params(error.to_string(), None))?;
        let _guard = self.execution_lock.lock().await;
        match execute_observation(&self.config, &self.workspace, parsed).await {
            Ok(payload) => {
                let mut result = CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]);
                result.structured_content = Some(payload);
                Ok(result.into())
            }
            Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Owner-local browser observation failed: {error:#}"
            ))])
            .into()),
        }
    }
}

fn schema(value: JsonValue) -> Arc<JsonObject> {
    Arc::new(value.as_object().cloned().unwrap_or_default())
}

fn local_browser_tools() -> Vec<Tool> {
    vec![Tool::new(
        Cow::Borrowed("observe"),
        Cow::Borrowed(
            "Open one public HTTP(S) page in a fresh read-only headless browser, return bounded CSS/text observations, and optionally save a PNG screenshot under artifacts/browser/.",
        ),
        schema(json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "minLength": 1, "maxLength": MAX_URL_CHARS },
                "observations": {
                    "type": "array", "minItems": 1, "maxItems": MAX_OBSERVATIONS,
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": { "type": "string", "minLength": 1, "maxLength": MAX_NAME_CHARS },
                            "selector": { "type": "string", "minLength": 1, "maxLength": MAX_SELECTOR_CHARS },
                            "text": { "type": "boolean" },
                            "computedStyles": {
                                "type": "array", "maxItems": MAX_STYLE_PROPERTIES,
                                "items": { "type": "string", "minLength": 1, "maxLength": MAX_STYLE_NAME_CHARS }
                            }
                        },
                        "required": ["name", "selector"],
                        "additionalProperties": false
                    }
                },
                "screenshot": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "minLength": 1, "maxLength": MAX_SCREENSHOT_PATH_CHARS },
                        "fullPage": { "type": "boolean" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                },
                "waitUntil": { "type": "string", "enum": ["domcontentloaded", "load", "networkidle"] },
                "timeoutMs": { "type": "integer", "minimum": 1_000, "maximum": MAX_TIMEOUT_MS }
            },
            "required": ["url", "observations"],
            "additionalProperties": false
        })),
    )]
}

fn parse_observe_request(arguments: Option<JsonObject>) -> Result<LocalBrowserRequest> {
    let mut arguments = arguments.unwrap_or_default();
    reject_unknown_fields(
        &arguments,
        &[
            "url",
            "observations",
            "screenshot",
            "waitUntil",
            "timeoutMs",
        ],
    )?;
    let url = arguments
        .remove("url")
        .and_then(|value| value.as_str().map(str::to_string))
        .context("observe requires a URL string")?;
    validate_url(&url)?;
    let observations = arguments
        .remove("observations")
        .and_then(|value| value.as_array().cloned())
        .context("observe requires an observations array")?;
    if observations.is_empty() || observations.len() > MAX_OBSERVATIONS {
        bail!("observe requires between 1 and {MAX_OBSERVATIONS} observations");
    }
    let observations = observations
        .into_iter()
        .map(validate_observation)
        .collect::<Result<Vec<_>>>()?;
    let screenshot = arguments
        .remove("screenshot")
        .map(validate_screenshot)
        .transpose()?;
    let screenshot_path = screenshot
        .as_ref()
        .and_then(|value| value.get("path"))
        .and_then(JsonValue::as_str)
        .map(str::to_string);
    let wait_until = match arguments.remove("waitUntil") {
        Some(JsonValue::String(value)) => value,
        Some(_) => bail!("waitUntil must be a string"),
        None => "load".to_string(),
    };
    if !matches!(
        wait_until.as_str(),
        "domcontentloaded" | "load" | "networkidle"
    ) {
        bail!("waitUntil must be domcontentloaded, load, or networkidle");
    }
    let timeout_ms = match arguments.remove("timeoutMs") {
        Some(JsonValue::Number(value)) => match value.as_u64() {
            Some(value) => value,
            None if value.is_i64() => bail!("timeoutMs must be a positive integer"),
            None => bail!("timeoutMs must be an integer"),
        },
        Some(_) => bail!("timeoutMs must be an integer"),
        None => DEFAULT_TIMEOUT_MS,
    };
    if !(1_000..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
        bail!("timeoutMs must be between 1000 and {MAX_TIMEOUT_MS}");
    }
    Ok(LocalBrowserRequest {
        payload: json!({
            "url": url,
            "observations": observations,
            "screenshot": screenshot,
            "waitUntil": wait_until,
            "timeoutMs": timeout_ms
        }),
        screenshot_path,
    })
}

fn reject_unknown_fields(object: &JsonMap<String, JsonValue>, allowed: &[&str]) -> Result<()> {
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        bail!("unsupported owner-local browser field {field}");
    }
    Ok(())
}

fn validate_url(raw: &str) -> Result<()> {
    if raw.chars().count() > MAX_URL_CHARS {
        bail!("browser URL is too long");
    }
    let url = reqwest::Url::parse(raw.trim()).context("browser URL must be absolute")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("browser URL must be credential-free HTTP(S)");
    }
    if !matches!(url.port_or_known_default(), Some(80 | 443)) {
        bail!("browser URL must use port 80 or 443");
    }
    let host = url.host_str().context("browser URL must include a host")?;
    if let Ok(address) = host.parse::<IpAddr>() {
        if !public_ip_literal_allowed(address) {
            bail!("browser URL cannot target a local, private, or reserved address");
        }
    } else {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if !host.contains('.')
            || host == "localhost"
            || host.ends_with(".localhost")
            || host.ends_with(".local")
            || host.ends_with(".internal")
            || host == "metadata"
            || host == "instance-data"
        {
            bail!("browser URL must use a public fully qualified hostname");
        }
    }
    Ok(())
}

fn public_ip_literal_allowed(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => public_ipv4_allowed(address),
        IpAddr::V6(address) => public_ipv6_allowed(address),
    }
}

fn public_ipv4_allowed(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || (a == 100 && (64..=127).contains(&b))
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && matches!(b, 18 | 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn public_ipv6_allowed(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return public_ipv4_allowed(mapped);
    }
    let segments = address.segments();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || segments[0] & 0xfe00 == 0xfc00
        || segments[0] & 0xffc0 == 0xfe80
        || (segments[0] == 0x0064 && segments[1] == 0xff9b)
        || (segments[0] == 0x0100 && segments[1..4] == [0, 0, 0])
        || (segments[0] == 0x2001 && segments[1] == 0)
        || (segments[0] == 0x2001 && segments[1] == 2 && segments[2] == 0)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || segments[0] == 0x2002)
}

fn validate_observation(value: JsonValue) -> Result<JsonValue> {
    let mut object = value
        .as_object()
        .cloned()
        .context("each observation must be an object")?;
    reject_unknown_fields(&object, &["name", "selector", "text", "computedStyles"])?;
    let name = bounded_string(object.remove("name"), "observation name", MAX_NAME_CHARS)?;
    let selector = bounded_string(
        object.remove("selector"),
        "observation selector",
        MAX_SELECTOR_CHARS,
    )?;
    if selector.chars().any(char::is_control) {
        bail!("observation selector contains a control character");
    }
    let text = object
        .remove("text")
        .map(|value| {
            value
                .as_bool()
                .context("observation text must be a boolean")
        })
        .transpose()?
        .unwrap_or(false);
    let styles = object
        .remove("computedStyles")
        .map(|value| {
            value
                .as_array()
                .cloned()
                .context("computedStyles must be an array")
        })
        .transpose()?
        .unwrap_or_default();
    if styles.len() > MAX_STYLE_PROPERTIES {
        bail!("too many computed style properties");
    }
    let styles = styles
        .into_iter()
        .map(|value| {
            let name = bounded_string(Some(value), "computed style name", MAX_STYLE_NAME_CHARS)?;
            if !name.chars().all(|ch| ch.is_ascii_lowercase() || ch == '-') {
                bail!("computed style names must use lowercase ASCII letters and hyphens");
            }
            Ok(name)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({ "name": name, "selector": selector, "text": text, "computedStyles": styles }))
}

fn validate_screenshot(value: JsonValue) -> Result<JsonValue> {
    let mut object = value
        .as_object()
        .cloned()
        .context("screenshot must be an object")?;
    reject_unknown_fields(&object, &["path", "fullPage"])?;
    let path = bounded_string(
        object.remove("path"),
        "screenshot path",
        MAX_SCREENSHOT_PATH_CHARS,
    )?;
    validate_screenshot_path(&path)?;
    let full_page = object
        .remove("fullPage")
        .map(|value| {
            value
                .as_bool()
                .context("screenshot fullPage must be a boolean")
        })
        .transpose()?
        .unwrap_or(false);
    Ok(json!({ "path": path, "fullPage": full_page }))
}

fn bounded_string(value: Option<JsonValue>, label: &str, max_chars: usize) -> Result<String> {
    let value = value
        .and_then(|value| value.as_str().map(str::to_string))
        .with_context(|| format!("{label} must be a string"))?;
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_chars {
        bail!("{label} is empty or too long");
    }
    Ok(value.to_string())
}

fn validate_screenshot_path(raw: &str) -> Result<()> {
    let components = Path::new(raw).components().collect::<Vec<_>>();
    if components.len() < 3
        || components[0].as_os_str() != "artifacts"
        || components[1].as_os_str() != "browser"
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
        || Path::new(raw).extension().and_then(|value| value.to_str()) != Some("png")
    {
        bail!("screenshot path must be a relative PNG under artifacts/browser/");
    }
    Ok(())
}

fn validate_png_bytes(bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_SCREENSHOT_BYTES {
        bail!("browser screenshot is empty or exceeds the size limit");
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        bail!("browser observer returned bytes without a PNG signature");
    }
    Ok(())
}

struct EgressProxyProcess {
    child: Option<Child>,
    url: String,
}

impl EgressProxyProcess {
    async fn start(executable: &Path) -> Result<Self> {
        for _ in 0..3 {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .context("failed to reserve a loopback browser egress proxy port")?;
            let address = listener.local_addr()?;
            drop(listener);

            let mut command = Command::new(executable);
            apply_allowlisted_tokio_environment(&mut command, &[]);
            command
                .env("INSTAFY_BROWSER_EGRESS_PROXY_BIND", address.to_string())
                .env("INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS", "80,443")
                .env("INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS", "32")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            let child = command
                .spawn()
                .context("failed to launch the browser egress proxy")?;
            let mut proxy = Self {
                child: Some(child),
                url: format!("http://{address}"),
            };
            if proxy.wait_until_ready().await.is_ok() {
                return Ok(proxy);
            }
            let _ = proxy.shutdown().await;
        }
        bail!("browser egress proxy failed its loopback readiness check")
    }

    async fn wait_until_ready(&mut self) -> Result<()> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(500))
            .build()
            .context("failed to build browser egress proxy health client")?;
        let health_url = format!("{}/healthz", self.url);
        for _ in 0..40 {
            if self
                .child
                .as_mut()
                .context("browser egress proxy process is unavailable")?
                .try_wait()?
                .is_some()
            {
                bail!("browser egress proxy exited before becoming ready");
            }
            if let Ok(response) = client.get(&health_url).send().await
                && response.status().is_success()
                && response
                    .text()
                    .await
                    .is_ok_and(|body| body.contains(r#""policy":"public-http-only""#))
            {
                return Ok(());
            }
            sleep(Duration::from_millis(50)).await;
        }
        bail!("browser egress proxy readiness timed out")
    }

    async fn shutdown(&mut self) -> Result<()> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        if child.try_wait()?.is_none() {
            child
                .kill()
                .await
                .context("failed to stop browser egress proxy")?;
        }
        let _ = child.wait().await;
        Ok(())
    }
}

impl Drop for EgressProxyProcess {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

async fn execute_observation(
    config: &LocalBrowserConfig,
    workspace: &Path,
    request: LocalBrowserRequest,
) -> Result<JsonValue> {
    let mut proxy = EgressProxyProcess::start(&config.egress_proxy_path).await?;
    let mut command = Command::new(&config.node_path);
    apply_allowlisted_tokio_environment(&mut command, &[]);
    command
        .env(PLAYWRIGHT_PATH_ENV, &config.playwright_path)
        .env(CHROMIUM_PATH_ENV, &config.chromium_path)
        .env(PROXY_URL_ENV, &proxy.url)
        .arg("-e")
        .arg(OBSERVER_SCRIPT)
        .arg(serde_json::to_string(&request.payload)?)
        .kill_on_drop(true);
    let output = command.output().await;
    proxy.shutdown().await?;
    let output = output.context("failed to launch owner-local browser observer")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "browser observer exited with {}: {}",
            output.status,
            stderr.trim()
        );
    }
    let mut payload: JsonValue =
        serde_json::from_slice(&output.stdout).context("browser observer returned invalid JSON")?;
    let final_url = payload
        .get("url")
        .and_then(JsonValue::as_str)
        .context("browser observer omitted its final URL")?;
    validate_url(final_url).context("browser observer returned a prohibited final URL")?;
    let encoded = payload
        .as_object_mut()
        .and_then(|object| object.remove("screenshotDataBase64"));
    if let Some(path) = request.screenshot_path {
        let encoded = encoded
            .and_then(|value| value.as_str().map(str::to_string))
            .context("browser observer did not return screenshot bytes")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .context("browser observer returned invalid screenshot bytes")?;
        validate_png_bytes(&bytes)?;
        let root = origin_http_server::workspace_fs::WorkspaceDir::open(workspace)
            .context("failed to open workspace screenshot capability")?;
        let mut reader = bytes.as_slice();
        let copied = root
            .replace_file(&path, &mut reader, false)
            .context("failed to write contained browser screenshot")?;
        payload
            .as_object_mut()
            .context("browser observer result must be an object")?
            .insert(
                "screenshot".to_string(),
                json!({ "path": path, "bytes": copied, "mimeType": "image/png" }),
            );
    }
    Ok(payload)
}

pub fn mcp_environment(config: &LocalBrowserConfig, workspace: &Path) -> HashMap<String, String> {
    HashMap::from([
        (ENABLED_ENV.to_string(), "1".to_string()),
        (
            PLAYWRIGHT_PATH_ENV.to_string(),
            config.playwright_path.to_string_lossy().into_owned(),
        ),
        (
            CHROMIUM_PATH_ENV.to_string(),
            config.chromium_path.to_string_lossy().into_owned(),
        ),
        (
            EGRESS_PROXY_PATH_ENV.to_string(),
            config.egress_proxy_path.to_string_lossy().into_owned(),
        ),
        (
            NODE_PATH_ENV.to_string(),
            config.node_path.to_string_lossy().into_owned(),
        ),
        (
            WORKSPACE_PATH_ENV.to_string(),
            workspace.to_string_lossy().into_owned(),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_executable(path: &Path) {
        std::fs::write(path, b"test executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = path.metadata().unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).unwrap();
        }
    }

    #[test]
    fn disabled_or_incomplete_environment_has_no_capability() {
        assert_eq!(local_browser_config_from_reader(|_| None).unwrap(), None);
        for value in ["0", "false", "no", "off"] {
            assert_eq!(
                local_browser_config_from_reader(|key| {
                    (key == ENABLED_ENV).then(|| OsString::from(value))
                })
                .unwrap(),
                None
            );
        }
        let result = local_browser_config_from_reader(|key| {
            (key == ENABLED_ENV).then(|| OsString::from("1"))
        });
        assert!(result.is_err());
    }

    #[test]
    fn invalid_enable_values_fail_closed_instead_of_looking_disabled() {
        for value in ["", "auto", "enabled", "2"] {
            let error = local_browser_config_from_reader(|key| {
                (key == ENABLED_ENV).then(|| OsString::from(value))
            })
            .unwrap_err();
            assert!(error.to_string().contains(ENABLED_ENV));
        }
    }

    #[test]
    fn linux_identity_and_capability_preconditions_fail_closed() {
        let unprivileged = concat!(
            "Uid:\t501\t501\t501\t501\n",
            "CapInh:\t0000000000000000\n",
            "CapPrm:\t0000000000000000\n",
            "CapEff:\t0000000000000000\n",
            "CapAmb:\t0000000000000000\n",
        );
        validate_unprivileged_linux_identity(unprivileged).unwrap();
        validate_zero_linux_capability_masks(unprivileged).unwrap();

        let root_saved_id =
            unprivileged.replace("Uid:\t501\t501\t501\t501", "Uid:\t501\t501\t0\t501");
        assert!(validate_unprivileged_linux_identity(&root_saved_id).is_err());
        let effective_capability =
            unprivileged.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000200000");
        assert!(validate_zero_linux_capability_masks(&effective_capability).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn local_mcp_reexec_uses_the_running_linux_image_magic_link() {
        use std::os::unix::fs::MetadataExt;

        let executable = mcp_executable().unwrap();
        assert_eq!(executable, Path::new(MCP_SELF_EXE_PATH));
        assert!(
            std::fs::symlink_metadata(&executable)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let running_image = std::fs::metadata(&executable).unwrap();
        let invoked_image = std::fs::metadata(std::env::current_exe().unwrap()).unwrap();
        assert_eq!(
            (running_image.dev(), running_image.ino()),
            (invoked_image.dev(), invoked_image.ino())
        );
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn local_mcp_reexec_is_not_advertised_without_linux_procfs() {
        assert!(mcp_executable().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn non_unicode_enable_value_fails_closed() {
        use std::os::unix::ffi::OsStringExt;

        let error = local_browser_config_from_reader(|key| {
            (key == ENABLED_ENV).then(|| OsString::from_vec(vec![0xff]))
        })
        .unwrap_err();
        assert!(error.to_string().contains("must contain Unicode text"));
    }

    #[test]
    fn complete_valid_environment_has_the_bounded_capability() {
        let install = tempfile::tempdir().unwrap();
        let playwright = install.path().join("playwright");
        std::fs::create_dir(&playwright).unwrap();
        std::fs::write(playwright.join("package.json"), b"{}").unwrap();
        let node = install.path().join("node");
        let chromium = install.path().join("chromium");
        let proxy = install.path().join("browser-egress-proxy");
        for path in [&node, &chromium, &proxy] {
            write_executable(path);
        }
        let environment = HashMap::from([
            (ENABLED_ENV, OsString::from("1")),
            (PLAYWRIGHT_PATH_ENV, playwright.clone().into_os_string()),
            (CHROMIUM_PATH_ENV, chromium.clone().into_os_string()),
            (EGRESS_PROXY_PATH_ENV, proxy.clone().into_os_string()),
            (NODE_PATH_ENV, node.clone().into_os_string()),
        ]);
        let config = local_browser_config_from_reader_with_trust(
            |key| environment.get(key).cloned(),
            |_| Ok(()),
        )
        .unwrap()
        .expect("valid local browser capability");
        assert_eq!(config.playwright_path, playwright.canonicalize().unwrap());
        assert_eq!(config.chromium_path, chromium.canonicalize().unwrap());
        assert_eq!(config.egress_proxy_path, proxy.canonicalize().unwrap());
        assert_eq!(config.node_path, node.canonicalize().unwrap());
        let mcp_environment = mcp_environment(&config, install.path());
        assert_eq!(mcp_environment.len(), 6);
        assert_eq!(
            mcp_environment.get(EGRESS_PROXY_PATH_ENV),
            Some(&proxy.canonicalize().unwrap().to_string_lossy().into_owned())
        );
        assert_eq!(
            capability_value(),
            json!({
                "enabled": true,
                "mode": "read-only-headless",
                "networkPolicy": "public-http-only",
                "computedStyles": true,
                "screenshots": true,
                "tools": ["observe"]
            })
        );
    }

    #[test]
    fn observe_validation_bounds_urls_selectors_styles_and_screenshot_paths() {
        let valid = parse_observe_request(Some(JsonMap::from_iter([
            ("url".to_string(), json!("https://example.com")),
            ("observations".to_string(), json!([{ "name": "hero", "selector": "h1", "text": true, "computedStyles": ["font-size"] }])),
            ("screenshot".to_string(), json!({ "path": "artifacts/browser/example.png", "fullPage": true })),
        ]))).expect("valid observation");
        assert_eq!(
            valid.screenshot_path.as_deref(),
            Some("artifacts/browser/example.png")
        );

        for url in [
            "file:///etc/passwd",
            "https://user:secret@example.com",
            "http://127.0.0.1",
            "http://169.254.169.254/latest/meta-data",
            "https://service.internal",
            "https://example.com:8443",
        ] {
            assert!(
                parse_observe_request(Some(JsonMap::from_iter([
                    ("url".to_string(), json!(url)),
                    (
                        "observations".to_string(),
                        json!([{ "name": "hero", "selector": "h1" }])
                    ),
                ])))
                .is_err()
            );
        }
        assert!(validate_screenshot_path("../outside.png").is_err());
        assert!(validate_screenshot_path("artifacts/browser/not-png.txt").is_err());
        assert!(
            validate_observation(
                json!({ "name": "hero", "selector": "h1", "computedStyles": ["FONT_SIZE"] })
            )
            .is_err()
        );
    }

    #[test]
    fn observe_validation_rejects_wrong_typed_wait_and_timeout_values() {
        let request = || {
            JsonMap::from_iter([
                ("url".to_string(), json!("https://example.com")),
                (
                    "observations".to_string(),
                    json!([{ "name": "hero", "selector": "h1" }]),
                ),
            ])
        };

        for value in [json!(false), json!(30_000)] {
            let mut arguments = request();
            arguments.insert("waitUntil".to_string(), value);
            let error = parse_observe_request(Some(arguments)).unwrap_err();
            assert!(error.to_string().contains("waitUntil must be a string"));
        }

        for value in [json!("30000"), json!(true), json!(30_000.5)] {
            let mut arguments = request();
            arguments.insert("timeoutMs".to_string(), value);
            let error = parse_observe_request(Some(arguments)).unwrap_err();
            assert!(error.to_string().contains("timeoutMs must be an integer"));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn dependency_trust_rejects_model_writable_install_paths() {
        let install = tempfile::tempdir().unwrap();
        let error = validate_root_owned_path(install.path(), CHROMIUM_PATH_ENV).unwrap_err();
        assert!(
            error.to_string().contains("must be root-owned")
                || error
                    .to_string()
                    .contains("must not be group- or world-writable")
        );
    }

    #[cfg(unix)]
    #[test]
    fn screenshot_writer_rejects_symlinked_ancestors() {
        use std::os::unix::fs::symlink;
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(workspace.path().join("artifacts")).unwrap();
        symlink(outside.path(), workspace.path().join("artifacts/browser")).unwrap();
        let root = origin_http_server::workspace_fs::WorkspaceDir::open(workspace.path()).unwrap();
        assert!(
            root.replace_file("artifacts/browser/escape.png", &mut &b"png"[..], false)
                .is_err()
        );
        assert!(!outside.path().join("escape.png").exists());
    }

    #[test]
    fn mcp_exposes_only_the_bounded_observe_tool_and_closes_browser() {
        let tools = local_browser_tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name.as_ref(), "observe");
        assert!(OBSERVER_SCRIPT.contains("await browser.close()"));
        assert!(OBSERVER_SCRIPT.contains("chromiumSandbox: true"));
        assert!(OBSERVER_SCRIPT.contains("--proxy-bypass-list=<-loopback>"));
        assert!(OBSERVER_SCRIPT.contains("--disable-quic"));
        assert!(OBSERVER_SCRIPT.contains("disable_non_proxied_udp"));
        assert!(OBSERVER_SCRIPT.contains("serviceWorkers: \"block\""));
        assert!(OBSERVER_SCRIPT.contains("MAX_STYLE_VALUE_CHARS"));
        assert!(OBSERVER_SCRIPT.contains("MAX_TITLE_CHARS"));
        assert!(OBSERVER_SCRIPT.contains("MAX_URL_CHARS"));
        assert!(!OBSERVER_SCRIPT.contains("eval("));
    }

    #[test]
    fn screenshot_bytes_must_really_be_png() {
        assert!(validate_png_bytes(b"not a png").is_err());
        let mut valid = PNG_SIGNATURE.to_vec();
        valid.extend_from_slice(b"bounded test payload");
        assert!(validate_png_bytes(&valid).is_ok());
    }
}
