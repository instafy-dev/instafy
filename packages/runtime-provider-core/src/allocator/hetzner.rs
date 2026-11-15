use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use tracing::info;
use uuid::Uuid;

use super::{
    canonical_managed_runtime_env_value, is_allowed_managed_runtime_env_key,
    is_exact_managed_provider, managed_webdev_generation_matches, runtime_metadata_for_process,
    EnsureRuntimeOutcome, EnsureRuntimeRequest, RuntimeAllocator, MANAGED_RUNTIME_FLAVOR_KEY,
    MANAGED_RUNTIME_LAUNCH_ATTESTATION, MANAGED_RUNTIME_WEBDEV_FLAVOR,
};
use crate::config::ProviderConfig;

#[derive(Clone)]
pub struct HetznerRuntimeAllocator {
    client: Client,
    token: String,
    server_type: String,
    image: String,
    location: String,
    network_id: u64,
    firewall_id: u64,
    user_data_template: String,
    project_prefix: String,
    runtime_agent_image: Option<String>,
    runtime_agent_webdev_image: Option<String>,
}

#[derive(Deserialize)]
struct CreateServerResponse {
    server: HetznerServer,
}

#[derive(Deserialize)]
struct HetznerServer {
    id: u64,
    name: String,
    #[serde(default)]
    labels: HashMap<String, String>,
}

impl HetznerRuntimeAllocator {
    pub(crate) fn new(config: &ProviderConfig) -> anyhow::Result<Self> {
        let token = config
            .hetzner_token
            .clone()
            .ok_or_else(|| anyhow::anyhow!("HCLOUD_TOKEN is required for Hetzner allocator"))?;
        let network_id = config.hetzner_network_id.ok_or_else(|| {
            anyhow::anyhow!("HETZNER_NETWORK_ID is required for Hetzner allocator")
        })?;
        let firewall_id = config.hetzner_firewall_id.ok_or_else(|| {
            anyhow::anyhow!("HETZNER_FIREWALL_ID is required for Hetzner allocator")
        })?;

        Ok(Self {
            client: Client::builder().timeout(Duration::from_secs(30)).build()?,
            token,
            server_type: config
                .hetzner_server_type
                .clone()
                .unwrap_or_else(|| "ccx13".to_string()),
            image: config
                .hetzner_image
                .clone()
                .unwrap_or_else(|| "ubuntu-22.04".to_string()),
            location: config
                .hetzner_location
                .clone()
                .unwrap_or_else(|| "hel1".to_string()),
            network_id,
            firewall_id,
            user_data_template: config
                .hetzner_runtime_user_data
                .clone()
                .unwrap_or_else(|| "#cloud-config\nruncmd: []\n".to_string()),
            project_prefix: config.runtime_docker_project_prefix.clone(),
            runtime_agent_image: config.runtime_agent_image.clone(),
            runtime_agent_webdev_image: config.runtime_agent_webdev_image.clone(),
        })
    }

    fn build_name(&self, project_id: Uuid, runtime_id: Uuid) -> String {
        let short = runtime_id.to_string();
        format!(
            "{}{}-{}",
            self.project_prefix,
            project_id.simple(),
            &short[..8]
        )
    }

    fn render_user_data(&self, request: &EnsureRuntimeRequest) -> anyhow::Result<String> {
        render_runtime_user_data_template(
            &self.user_data_template,
            request,
            self.runtime_agent_image.as_deref(),
            self.runtime_agent_webdev_image.as_deref(),
        )
    }

    async fn create_server(
        &self,
        name: &str,
        user_data: &str,
        labels: &HashMap<String, String>,
    ) -> anyhow::Result<HetznerServer> {
        let url = "https://api.hetzner.cloud/v1/servers";
        let body = serde_json::json!({
            "name": name,
            "server_type": self.server_type,
            "image": self.image,
            "location": self.location,
            "user_data": user_data,
            "networks": [self.network_id],
            "firewalls": [{
                "firewall": self.firewall_id
            }],
            "labels": labels,
        });
        let res = self
            .client
            .post(url)
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await?;

        if res.status() == StatusCode::CREATED {
            let payload: CreateServerResponse = res.json().await?;
            return Ok(payload.server);
        }

        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        anyhow::bail!("failed to create hetzner server: status={status} body={text}");
    }

    async fn delete_by_name(
        &self,
        name: &str,
        expected_lease_id: Option<Uuid>,
    ) -> anyhow::Result<()> {
        let url = format!("https://api.hetzner.cloud/v1/servers?name={}", name);
        let res = self
            .client
            .get(&url)
            .bearer_auth(&self.token)
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            anyhow::bail!("failed to inspect Hetzner runtime: status={status} body={body}");
        }
        #[derive(Deserialize)]
        struct ListResponse {
            servers: Vec<HetznerServer>,
        }
        let list: ListResponse = res.json().await?;
        if let Some(server) = list.servers.first() {
            if let Some(expected_lease_id) = expected_lease_id {
                let observed_lease_id = server
                    .labels
                    .get("lease")
                    .and_then(|value| Uuid::parse_str(value).ok());
                match observed_lease_id {
                    Some(observed_lease_id) if observed_lease_id == expected_lease_id => {}
                    Some(observed_lease_id) => {
                        anyhow::bail!(
                            "Hetzner runtime lease generation mismatch for server {}: expected {}, observed {}",
                            server.id,
                            expected_lease_id,
                            observed_lease_id
                        );
                    }
                    None => {
                        anyhow::bail!(
                            "cannot prove Hetzner runtime lease generation for server {}",
                            server.id
                        );
                    }
                }
            }
            let del_url = format!("https://api.hetzner.cloud/v1/servers/{}", server.id);
            let delete_response = self
                .client
                .delete(del_url)
                .bearer_auth(&self.token)
                .send()
                .await?;
            if !delete_response.status().is_success()
                && delete_response.status() != StatusCode::NOT_FOUND
            {
                let status = delete_response.status();
                let body = delete_response.text().await.unwrap_or_default();
                anyhow::bail!("failed to delete Hetzner runtime: status={status} body={body}");
            }
        }
        Ok(())
    }
}

/// The placeholders a user-data template may hold.
#[derive(Clone, Copy)]
enum UserDataPlaceholder {
    ProjectId,
    RuntimeId,
    LeaseId,
    RuntimeToken,
    RuntimeAgentImage,
    OriginInstanceId,
    OriginMode,
    OriginProtocols,
    OriginMetadataJson,
    RuntimeMetadataJson,
    RuntimeEnvFlags,
    RuntimeEnvExports,
}

const USER_DATA_PLACEHOLDERS: [(&str, UserDataPlaceholder); 12] = [
    ("{{PROJECT_ID}}", UserDataPlaceholder::ProjectId),
    ("{{RUNTIME_ID}}", UserDataPlaceholder::RuntimeId),
    ("{{LEASE_ID}}", UserDataPlaceholder::LeaseId),
    ("{{RUNTIME_TOKEN}}", UserDataPlaceholder::RuntimeToken),
    (
        "{{RUNTIME_AGENT_IMAGE}}",
        UserDataPlaceholder::RuntimeAgentImage,
    ),
    (
        "{{ORIGIN_INSTANCE_ID}}",
        UserDataPlaceholder::OriginInstanceId,
    ),
    ("{{ORIGIN_MODE}}", UserDataPlaceholder::OriginMode),
    ("{{ORIGIN_PROTOCOLS}}", UserDataPlaceholder::OriginProtocols),
    (
        "{{ORIGIN_METADATA_JSON}}",
        UserDataPlaceholder::OriginMetadataJson,
    ),
    (
        "{{RUNTIME_METADATA_JSON}}",
        UserDataPlaceholder::RuntimeMetadataJson,
    ),
    (
        "{{RUNTIME_ENV_FLAGS}}",
        UserDataPlaceholder::RuntimeEnvFlags,
    ),
    (
        "{{RUNTIME_ENV_EXPORTS}}",
        UserDataPlaceholder::RuntimeEnvExports,
    ),
];

/// Fills the operator's user-data template for one launch.
///
/// cloud-init runs a `#!` user-data as a shell script and parses a
/// `#cloud-config` one as YAML (rendering it with Jinja first when it starts
/// with `## template: jinja`), and much of what fills the placeholders comes
/// from the launch request. So the template is filled in a single pass, which
/// never reads a value as another placeholder, and every value is rendered to
/// read back unchanged in a shell command, in a YAML plain or block scalar and
/// under Jinja: see [`shell_quote`], [`user_data_json`], [`user_data_word`]
/// and [`is_user_data_image_reference`]. A launch whose value cannot be
/// rendered that way fails instead.
fn render_runtime_user_data_template(
    template: &str,
    request: &EnsureRuntimeRequest,
    provider_runtime_image: Option<&str>,
    provider_webdev_image: Option<&str>,
) -> anyhow::Result<String> {
    let runtime_image = resolve_runtime_agent_image_for_request(
        request,
        provider_runtime_image,
        provider_webdev_image,
    )?;
    anyhow::ensure!(
        is_user_data_image_reference(&runtime_image),
        "Hetzner runtime image reference must start with a letter or digit and hold only letters, digits and . _ / : @ + -"
    );

    let process_metadata =
        runtime_metadata_for_process(&request.provider, request.metadata.as_ref());
    let runtime_env = build_runtime_env(request, process_metadata.as_ref())?;
    let runtime_env_flags = build_shell_env_flags(&runtime_env);
    // Backward-compatible fallback: a template without `{{RUNTIME_ENV_FLAGS}}`
    // gets the runtime env flags just before each space-preceded
    // `{{RUNTIME_AGENT_IMAGE}}`.
    let flags_before_image = !template.contains("{{RUNTIME_ENV_FLAGS}}");

    let mut rendered = String::with_capacity(template.len());
    let mut offset = 0;
    while let Some(found) = template[offset..].find("{{") {
        let start = offset + found;
        rendered.push_str(&template[offset..start]);
        let Some((token, placeholder)) = USER_DATA_PLACEHOLDERS
            .iter()
            .find(|(token, _)| template[start..].starts_with(token))
        else {
            rendered.push('{');
            offset = start + 1;
            continue;
        };
        let value = match placeholder {
            UserDataPlaceholder::ProjectId => request.project_id.to_string(),
            UserDataPlaceholder::RuntimeId => request.runtime_id.to_string(),
            UserDataPlaceholder::LeaseId => request.lease_id.to_string(),
            UserDataPlaceholder::RuntimeToken => user_data_word(token, &request.runtime_token)?,
            UserDataPlaceholder::RuntimeAgentImage
                if flags_before_image && template[..start].ends_with(' ') =>
            {
                format!("{runtime_env_flags} {runtime_image}")
            }
            UserDataPlaceholder::RuntimeAgentImage => runtime_image.clone(),
            UserDataPlaceholder::OriginInstanceId => request
                .origin_instance_id
                .map(|value| value.to_string())
                .unwrap_or_default(),
            UserDataPlaceholder::OriginMode => {
                user_data_word(token, request.origin_mode.as_deref().unwrap_or_default())?
            }
            UserDataPlaceholder::OriginProtocols => request
                .origin_protocols
                .iter()
                .map(|protocol| user_data_word(token, protocol))
                .collect::<anyhow::Result<Vec<_>>>()?
                .join(","),
            UserDataPlaceholder::OriginMetadataJson => request
                .origin_metadata
                .as_ref()
                .map(user_data_json)
                .unwrap_or_default(),
            UserDataPlaceholder::RuntimeMetadataJson => process_metadata
                .as_ref()
                .map(user_data_json)
                .unwrap_or_default(),
            UserDataPlaceholder::RuntimeEnvFlags => runtime_env_flags.clone(),
            UserDataPlaceholder::RuntimeEnvExports => {
                build_shell_env_exports(&runtime_env, line_indent(template, start))
            }
        };
        rendered.push_str(&value);
        offset = start + token.len();
    }
    rendered.push_str(&template[offset..]);
    Ok(rendered)
}

fn resolve_runtime_agent_image_for_request(
    request: &EnsureRuntimeRequest,
    provider_runtime_image: Option<&str>,
    provider_webdev_image: Option<&str>,
) -> anyhow::Result<String> {
    let fallback = || {
        provider_runtime_image.map(str::to_string).ok_or_else(|| {
            anyhow::anyhow!(
                "Hetzner runtime launch requires an explicit provider RUNTIME_AGENT_IMAGE"
            )
        })
    };
    if !is_exact_managed_provider(&request.provider) {
        return request
            .metadata
            .as_ref()
            .and_then(resolve_runtime_agent_image)
            .map(Ok)
            .unwrap_or_else(fallback);
    }

    let flavor = request
        .metadata
        .as_ref()
        .and_then(JsonValue::as_object)
        .and_then(|root| root.get(MANAGED_RUNTIME_FLAVOR_KEY))
        .and_then(JsonValue::as_str);
    let has_attestation = request
        .metadata
        .as_ref()
        .and_then(JsonValue::as_object)
        .is_some_and(|root| root.contains_key(MANAGED_RUNTIME_LAUNCH_ATTESTATION));
    match flavor {
        None if !has_attestation => fallback(),
        Some(MANAGED_RUNTIME_WEBDEV_FLAVOR)
            if managed_webdev_generation_matches(request.metadata.as_ref(), request.lease_id) =>
        {
            provider_webdev_image.map(str::to_string).ok_or_else(|| {
                anyhow::anyhow!(
                    "managed webdev launch requires provider RUNTIME_AGENT_WEBDEV_IMAGE"
                )
            })
        }
        Some(MANAGED_RUNTIME_WEBDEV_FLAVOR) => anyhow::bail!(
            "managed webdev launch attestation does not match runtime lease generation"
        ),
        Some(other) => anyhow::bail!("unsupported managed runtime flavor {other:?}"),
        None => anyhow::bail!("managed runtime launch attestation is missing its flavor"),
    }
}

fn build_runtime_env(
    request: &EnsureRuntimeRequest,
    process_metadata: Option<&JsonValue>,
) -> anyhow::Result<Vec<(String, String)>> {
    let mut env = Vec::new();
    env.push(("SPACE_ID".to_string(), request.project_id.to_string()));
    env.push(("RUNTIME_ID".to_string(), request.runtime_id.to_string()));
    env.push(("RUNTIME_LEASE_ID".to_string(), request.lease_id.to_string()));
    env.push(("RUNTIME_PROVIDER".to_string(), request.provider.clone()));
    env.push((
        "RUNTIME_ACCESS_TOKEN".to_string(),
        request.runtime_token.clone(),
    ));
    env.push((
        "ORIGIN_INTERNAL_TOKEN".to_string(),
        request.runtime_token.clone(),
    ));
    if let Some(origin_id) = request.origin_instance_id {
        env.push(("ORIGIN_ID".to_string(), origin_id.to_string()));
    }
    env.push(("ORIGIN_LEASE_ID".to_string(), request.lease_id.to_string()));

    if let Some(mode) = request
        .origin_mode
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        env.push(("ORIGIN_MODE".to_string(), mode.to_string()));
    }
    if !request.origin_protocols.is_empty() {
        env.push((
            "ORIGIN_PROTOCOLS".to_string(),
            request.origin_protocols.join(","),
        ));
    }
    if let Some(origin_metadata) = request.origin_metadata.as_ref() {
        env.push((
            "ORIGIN_METADATA".to_string(),
            user_data_json(origin_metadata),
        ));
    }
    if let Some(metadata) = process_metadata {
        env.push(("RUNTIME_METADATA".to_string(), user_data_json(metadata)));
        // What the allocator set above (the runtime's ids, its token, its lease and origin
        // settings) stays as the allocator set it.
        let allocator_set: HashSet<String> = env.iter().map(|(key, _)| key.clone()).collect();
        env.extend(metadata_env_pairs(
            metadata,
            is_exact_managed_provider(&request.provider),
            &allocator_set,
        ));
    }

    if let Some((key, _)) = env.iter().find(|(_, value)| !is_user_data_text(value)) {
        anyhow::bail!(
            "Hetzner user-data cannot carry {key}: a launch value must be one line of printable text"
        );
    }
    Ok(env)
}

/// The variables a launch request may set for a provider other than exact
/// instafy_cloud, besides the managed launch keys: the runtime container's own
/// settings, which the runtime compose files pass into the runtime's
/// `environment:` and use nowhere else. `{{RUNTIME_ENV_EXPORTS}}` exports a
/// request's variables in the server's boot shell, ahead of the commands the
/// template runs there, so none of these is a setting Docker tools, the shell,
/// the dynamic loader or an HTTP proxy client reads (a test below keeps it
/// that way). The allocator's own value still wins for the ones it sets
/// itself, such as the runtime's ids, token and origin settings.
const RUNTIME_CONTAINER_ENV_KEYS: &[&str] = &[
    "CODEX_API_ENDPOINT",
    "CODEX_API_KEY",
    "CODEX_AUTH_PATH",
    "CODEX_BASE_INSTRUCTIONS",
    "CODEX_CHATGPT_ENDPOINT",
    "CODEX_DISABLED",
    "CODEX_INCLUDE_APPLY_PATCH_TOOL",
    "CODEX_INCLUDE_PLAN_TOOL",
    "CODEX_INCLUDE_VIEW_IMAGE_TOOL",
    "CODEX_MODEL",
    "CODEX_MODEL_PROVIDER",
    "CODEX_PROFILE",
    "CODEX_PROXY_CHATGPT_ENDPOINT",
    "CODEX_SANDBOX_MODE",
    "CODEX_SHOW_RAW_AGENT_REASONING",
    "INSTAFY_BROWSER_CDP_SCREENCAST",
    "INSTAFY_BROWSER_DISPLAY",
    "INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS",
    "INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV",
    "INSTAFY_BROWSER_EGRESS_ISOLATION",
    "INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS",
    "INSTAFY_BROWSER_EGRESS_PROXY_BIND",
    "INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS",
    "INSTAFY_BROWSER_PREFERRED_VIEWER",
    "INSTAFY_BROWSER_PROFILE_PERSIST",
    "INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS",
    "INSTAFY_BROWSER_RENDER_SCALE",
    "INSTAFY_BROWSER_VIEWPORT_ONLY",
    "INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS",
    "INSTAFY_BROWSER_WEBRTC_ENABLED",
    "INSTAFY_BROWSER_WEBRTC_FPS",
    "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON",
    "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN",
    "INSTAFY_ENABLE_BROWSER_SESSION",
    "INSTAFY_PLAYWRIGHT_MCP_ALLOW_ISOLATED",
    "INSTAFY_PLAYWRIGHT_MCP_MODE",
    "INSTAFY_PLAYWRIGHT_MCP_PORT",
    "INSTAFY_PLAYWRIGHT_MCP_PROFILE_DIR",
    "INSTAFY_VNC_DEPTH",
    "INSTAFY_VNC_GEOMETRY",
    "INSTAFY_VNC_HOST",
    "INSTAFY_VNC_PORT",
    "OPENAI_BASE_URL",
    "ORIGIN_BIND_HOST",
    "ORIGIN_BIND_PORT",
    "ORIGIN_DEVICE_ID",
    "ORIGIN_ENABLE_PRESENCE_HEARTBEAT",
    "ORIGIN_ENDPOINT",
    "ORIGIN_GIT_REMOTE_URL",
    "ORIGIN_ID",
    "ORIGIN_LEASE_ID",
    "ORIGIN_METADATA",
    "ORIGIN_MODE",
    "ORIGIN_PROTOCOLS",
    "ORIGIN_SKIP_AUTH",
    "ORIGIN_TUNNEL_ENABLED",
    "PROXY_BASE_URL",
    "PROXY_TOKEN_TTL_SECONDS",
    "RUNTIME_ACCESS_TOKEN",
    "RUNTIME_CAPABILITIES",
    "RUNTIME_DEV_ISOLATION",
    "RUNTIME_HEARTBEAT_SECONDS",
    "RUNTIME_ID",
    "RUNTIME_LEASE_ID",
    "RUNTIME_LEASE_SECONDS",
    "RUNTIME_METADATA",
    "RUNTIME_STRICT_MODE",
    "RUNTIME_TYPE",
    "RUNTIME_VERSION",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "USE_PROXY_FOR_LLM",
];

/// Whether a request's `metadata.env` entry reaches user-data. Exact
/// instafy_cloud takes only the managed launch keys, with scalar values; any
/// other provider also takes [`RUNTIME_CONTAINER_ENV_KEYS`].
fn request_may_set_runtime_env(exact_managed_provider: bool, key: &str, value: &JsonValue) -> bool {
    if exact_managed_provider {
        return is_allowed_managed_runtime_env_key(key)
            && canonical_managed_runtime_env_value(value).is_some();
    }
    is_allowed_managed_runtime_env_key(key) || RUNTIME_CONTAINER_ENV_KEYS.contains(&key)
}

fn metadata_env_pairs(
    metadata: &JsonValue,
    exact_managed_provider: bool,
    allocator_set: &HashSet<String>,
) -> Vec<(String, String)> {
    let env_map = metadata
        .as_object()
        .and_then(|obj| obj.get("env"))
        .and_then(JsonValue::as_object);
    let Some(env_map) = env_map else {
        return Vec::new();
    };

    let mut entries = Vec::new();
    for (key, value) in env_map {
        if allocator_set.contains(key)
            || !request_may_set_runtime_env(exact_managed_provider, key, value)
            || !is_valid_env_key(key)
        {
            continue;
        }
        let rendered = match value {
            JsonValue::String(raw) => raw.clone(),
            JsonValue::Number(number) => number.to_string(),
            JsonValue::Bool(flag) => {
                if *flag {
                    "1".to_string()
                } else {
                    "0".to_string()
                }
            }
            JsonValue::Null => continue,
            other => user_data_json(other),
        };
        if rendered.is_empty() {
            continue;
        }
        entries.push((key.to_string(), rendered));
    }

    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// Whether `value` is one line of printable text, the only kind user-data can
/// carry. cloud-init reads a cloud-config template as YAML 1.1, where `\n`,
/// `\r`, U+0085, U+2028 and U+2029 all end a line, and where any other control
/// character, a byte order mark, U+FFFE or U+FFFF makes the document
/// unreadable.
fn is_user_data_text(value: &str) -> bool {
    !value.chars().any(|ch| {
        ch.is_control()
            || matches!(
                ch,
                '\u{2028}' | '\u{2029}' | '\u{feff}' | '\u{fffe}' | '\u{ffff}'
            )
    })
}

/// One POSIX shell word that the shell reads back as exactly `value`, which
/// must be user-data text ([`is_user_data_text`]).
///
/// A cloud-config template puts the word inside a YAML scalar, and a
/// `## template: jinja` user-data is rendered by Jinja first, so the word never
/// holds a pair of characters that either would read: `: ` and ` #` end a YAML
/// plain scalar, and `{{`, `{%` and `{#` open a Jinja tag. Between the two
/// characters of such a pair the quote is closed and opened again, which the
/// shell joins back into the same word.
fn shell_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    let mut previous = None;
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\"'\"'");
            previous = None;
            continue;
        }
        if previous.is_some_and(|previous| {
            matches!(
                (previous, ch),
                (' ', '#') | (':', ' ') | ('{', '{' | '%' | '#')
            )
        }) {
            quoted.push_str("''");
        }
        quoted.push(ch);
        previous = Some(ch);
    }
    quoted.push('\'');
    quoted
}

/// Compact JSON that parses back to `value`, with every string character other
/// than an ASCII letter, digit, space or one of `_ . , / @ + = -` written as a
/// `\uXXXX` escape. So the text holds no line break, no quote but JSON's own
/// double quotes, no `#`, `$` or backslash outside an escape, no `:` but the
/// ones after keys and no `{{`, `{%` or `{#`. Inside a single-quoted shell
/// word, a YAML plain or block scalar, or Jinja input, it stays one inert piece
/// of text.
fn user_data_json(value: &JsonValue) -> String {
    let mut json = String::new();
    write_user_data_json(value, &mut json);
    json
}

fn write_user_data_json(value: &JsonValue, json: &mut String) {
    match value {
        JsonValue::Null => json.push_str("null"),
        JsonValue::Bool(flag) => json.push_str(if *flag { "true" } else { "false" }),
        JsonValue::Number(number) => json.push_str(&number.to_string()),
        JsonValue::String(text) => write_user_data_json_string(text, json),
        JsonValue::Array(items) => {
            json.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    json.push(',');
                }
                write_user_data_json(item, json);
            }
            json.push(']');
        }
        JsonValue::Object(entries) => {
            json.push('{');
            for (index, (key, item)) in entries.iter().enumerate() {
                if index > 0 {
                    json.push(',');
                }
                write_user_data_json_string(key, json);
                json.push(':');
                write_user_data_json(item, json);
            }
            json.push('}');
        }
    }
}

fn write_user_data_json_string(text: &str, json: &mut String) {
    json.push('"');
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric()
            || matches!(ch, ' ' | '_' | '.' | ',' | '/' | '@' | '+' | '=' | '-')
        {
            json.push(ch);
        } else {
            let mut units = [0u16; 2];
            for unit in ch.encode_utf16(&mut units) {
                let _ = write!(json, "\\u{unit:04x}");
            }
        }
    }
    json.push('"');
}

/// A placeholder value the template takes as is: empty, or a letter or digit
/// followed by letters, digits and `. _ + -`.
fn user_data_word(placeholder: &str, value: &str) -> anyhow::Result<String> {
    let word = value.is_empty()
        || (value.starts_with(|ch: char| ch.is_ascii_alphanumeric())
            && value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '+' | '-')));
    anyhow::ensure!(
        word,
        "Hetzner user-data cannot carry {placeholder}: its value must be letters, digits and . _ + - only"
    );
    Ok(value.to_string())
}

/// An image reference the template can take as is: at most 512 characters, a
/// letter or digit and then letters, digits and `. _ / : @ + -`, not ending in
/// `:`.
fn is_user_data_image_reference(value: &str) -> bool {
    value.len() <= 512
        && value.starts_with(|ch: char| ch.is_ascii_alphanumeric())
        && !value.ends_with(':')
        && value.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '/' | ':' | '@' | '+' | '-')
        })
}

fn build_shell_env_flags(values: &[(String, String)]) -> String {
    values
        .iter()
        .map(|(key, value)| format!("-e {}={}", key, shell_quote(value)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `export KEY='value'` lines. Each line after the first starts with `indent`,
/// the placeholder's own indentation, so that all of them stay in a YAML block
/// scalar the placeholder sits in.
fn build_shell_env_exports(values: &[(String, String)], indent: &str) -> String {
    values
        .iter()
        .map(|(key, value)| format!("export {}={}", key, shell_quote(value)))
        .collect::<Vec<_>>()
        .join(&format!("\n{indent}"))
}

/// The spaces and tabs before `start` on its line, when nothing else comes
/// before it there.
fn line_indent(template: &str, start: usize) -> &str {
    let line_start = template[..start].rfind('\n').map_or(0, |index| index + 1);
    let indent = &template[line_start..start];
    if indent.chars().all(|ch| ch == ' ' || ch == '\t') {
        indent
    } else {
        ""
    }
}

fn resolve_runtime_agent_image(metadata: &serde_json::Value) -> Option<String> {
    let meta = metadata.as_object()?;
    let raw = meta
        .get("runtimeAgentImage")
        .or_else(|| meta.get("runtime_agent_image"))
        .or_else(|| meta.get("runtime-agent-image"))
        .and_then(|value| value.as_str())?;

    let trimmed = raw.trim();
    is_user_data_image_reference(trimmed).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_request() -> EnsureRuntimeRequest {
        EnsureRuntimeRequest {
            project_id: Uuid::parse_str("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").unwrap(),
            runtime_id: Uuid::parse_str("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb").unwrap(),
            lease_id: Uuid::parse_str("cccccccc-cccc-cccc-cccc-cccccccccccc").unwrap(),
            provider: "hetzner".to_string(),
            runtime_token: "token-123".to_string(),
            metadata: Some(json!({
                "runtimeAgentImage": "ghcr.io/instafy-dev/instafy-runtime-agent:webdev",
                "env": {
                    "INSTAFY_ENABLE_BROWSER_SESSION": "1",
                    "INSTAFY_VNC_PORT": 5900,
                    "DOCKER_HOST": "tcp://custom-docker.test:2375",
                    "CUSTOM_RUNTIME_SETTING": "preserved"
                }
            })),
            origin_instance_id: Some(
                Uuid::parse_str("dddddddd-dddd-dddd-dddd-dddddddddddd").unwrap(),
            ),
            origin_mode: Some("hosted".to_string()),
            origin_protocols: vec!["http".to_string()],
            origin_metadata: Some(json!({"source": "browser-session"})),
        }
    }

    const PROVIDER_IMAGE: &str = "registry.example/runtime@sha256:0123abcd";

    /// Runs `script` with /bin/sh, as cloud-init runs a runcmd item, and returns what it
    /// printed. The scripts only print; a value that escaped its quoting would print
    /// something else, not run.
    fn sh(script: &str) -> String {
        let output = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .output()
            .expect("run /bin/sh");
        assert!(
            output.status.success(),
            "sh failed: {}\n{script}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("utf-8 output")
    }

    /// The runcmd items of rendered cloud-config, read as cloud-init reads them: a YAML 1.1
    /// document whose only key is `runcmd` and whose items are all strings.
    fn runcmd(rendered: &str) -> Vec<String> {
        let document: serde_yaml::Value =
            serde_yaml::from_str(rendered).unwrap_or_else(|error| panic!("{error}\n{rendered}"));
        let keys: Vec<_> = document
            .as_mapping()
            .unwrap_or_else(|| panic!("not a mapping:\n{rendered}"))
            .keys()
            .collect();
        assert_eq!(keys, [&serde_yaml::Value::from("runcmd")], "{rendered}");
        document["runcmd"]
            .as_sequence()
            .unwrap_or_else(|| panic!("runcmd is not a list:\n{rendered}"))
            .iter()
            .map(|item| {
                item.as_str()
                    .unwrap_or_else(|| panic!("runcmd item {item:?} is not a string:\n{rendered}"))
                    .to_string()
            })
            .collect()
    }

    /// The `KEY=value` words `printf '%s\n'` prints for each `-e` of rendered env flags.
    fn printed_flags(printed: &str) -> Vec<(String, String)> {
        let lines: Vec<&str> = printed.lines().collect();
        assert_eq!(lines.len() % 2, 0, "{printed}");
        lines
            .chunks(2)
            .map(|pair| {
                assert_eq!(pair[0], "-e", "{printed}");
                let (key, value) = pair[1].split_once('=').expect("KEY=value");
                (key.to_string(), value.to_string())
            })
            .collect()
    }

    fn flag<'a>(flags: &'a [(String, String)], key: &str) -> Option<&'a str> {
        let mut values = flags
            .iter()
            .filter(|(name, _)| name == key)
            .map(|(_, value)| value.as_str());
        let value = values.next();
        assert_eq!(values.next(), None, "{key} is set more than once");
        value
    }

    /// A template without `{{RUNTIME_ENV_FLAGS}}` gets the flags just before the image, and
    /// still gets the image.
    #[test]
    fn a_template_without_env_flags_gets_them_before_the_image() {
        let template = "#cloud-config\nruncmd:\n  - printf '%s\\n' {{RUNTIME_AGENT_IMAGE}}\n";
        let mut request = sample_request();
        request.metadata = Some(json!({ "env": { "INSTAFY_ENABLE_BROWSER_SESSION": "1" } }));
        let rendered =
            render_runtime_user_data_template(template, &request, Some(PROVIDER_IMAGE), None)
                .expect("rendered user data");
        assert!(!rendered.contains("RUNTIME_AGENT_IMAGE"), "{rendered}");

        let printed = sh(&runcmd(&rendered)[0]);
        let (flags, image) = printed
            .trim_end_matches('\n')
            .rsplit_once('\n')
            .expect("flags and image");
        assert_eq!(image, PROVIDER_IMAGE);
        let flags = printed_flags(flags);
        assert_eq!(
            flag(&flags, "SPACE_ID"),
            Some(request.project_id.to_string().as_str())
        );
        assert_eq!(flag(&flags, "RUNTIME_ACCESS_TOKEN"), Some("token-123"));
        assert_eq!(flag(&flags, "INSTAFY_ENABLE_BROWSER_SESSION"), Some("1"));
    }

    #[test]
    fn render_populates_runtime_env_flag_placeholder() {
        let template = r#"#cloud-config
runcmd:
  - docker run -d --name instafy-runtime --restart unless-stopped {{RUNTIME_ENV_FLAGS}} {{RUNTIME_AGENT_IMAGE}}
"#;
        let rendered = render_runtime_user_data_template(template, &sample_request(), None, None)
            .expect("rendered user data");
        assert!(rendered.contains("RUNTIME_ACCESS_TOKEN='token-123'"));
        assert!(!rendered.contains("ORIGIN_ACCESS_TOKEN"));
        assert!(rendered.contains("ORIGIN_MODE='hosted'"));
        assert!(rendered.contains("ORIGIN_PROTOCOLS='http'"));
        assert!(rendered.contains("INSTAFY_ENABLE_BROWSER_SESSION='1'"));
    }

    #[test]
    fn managed_webdev_maps_to_provider_image_and_strips_protected_env() {
        let template = r#"#cloud-config
runcmd:
  - docker run {{RUNTIME_ENV_FLAGS}} {{RUNTIME_AGENT_IMAGE}}
"#;
        let mut request = sample_request();
        request.provider = "instafy-cloud".to_string();
        request.metadata = Some(json!({
            "runtimeFlavor": "webdev",
            "runtimeAgentImage": "attacker/image:direct",
            "_instafyManagedRuntimeLaunch": {
                "version": 1,
                "flavor": "webdev",
                "generation": request.lease_id.to_string(),
            },
            "env": {
                "RUNTIME_AGENT_IMAGE": "attacker/image:env",
                "RUNTIME_CAPABILITIES": "{\"spoofed\":true}",
                "INSTAFY_BROWSER_AGENT_CONTROL_FILE": "/tmp/attacker-control.json",
                "INSTAFY_SHARED_BROWSER_APPROVAL_DIR": "/tmp/attacker-approvals",
                "INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS": "60000",
                "DOCKER_HOST": "tcp://attacker.test:2375",
                "DOCKER_CONFIG": "/tmp/attacker-docker-config",
                "COMPOSE_FILE": "/tmp/attacker-compose.yml",
                "BUILDKIT_HOST": "tcp://attacker.test:1234",
                "PATH": "/tmp/attacker-bin",
                "BASH_ENV": "/tmp/attacker-shell-init",
                "LD_PRELOAD": "/tmp/attacker.so",
                "HTTP_PROXY": "http://attacker.test:8080",
                "NO_PROXY": "controller.internal",
                "PROXY_BASE_URL": "https://attacker.test/v1",
                "RUNTIME_AGENT_BUILD_TARGET": "attacker-target",
                "RUNTIME_AGENT_FORCE_BUILD": "1",
                "CODEX_SANDBOX_MODE": "workspace-write",
                "INSTAFY_ENABLE_BROWSER_SESSION": "1",
                "INSTAFY_BROWSER_CDP_SCREENCAST": true,
                "INSTAFY_VNC_PORT": 5900,
                "INSTAFY_VNC_GEOMETRY": {"width": 1280},
                "RUNTIME_CPU_LIMIT": "2",
                "RUNTIME_MEMORY_LIMIT": "4g",
            }
        }));

        let rendered = render_runtime_user_data_template(
            template,
            &request,
            Some("runtime-agent:base-sha"),
            Some("runtime-agent:webdev-sha"),
        )
        .expect("managed user data");
        assert!(rendered.contains("runtime-agent:webdev-sha"));
        assert!(!rendered.contains("attacker/image"));
        assert!(!rendered.contains("RUNTIME_CAPABILITIES"));
        assert!(!rendered.contains("INSTAFY_BROWSER_AGENT_CONTROL_FILE"));
        assert!(!rendered.contains("INSTAFY_SHARED_BROWSER_APPROVAL_DIR"));
        assert!(!rendered.contains("INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS"));
        for key in [
            "DOCKER_HOST",
            "DOCKER_CONFIG",
            "COMPOSE_FILE",
            "BUILDKIT_HOST",
            "PATH",
            "BASH_ENV",
            "LD_PRELOAD",
            "HTTP_PROXY",
            "NO_PROXY",
            "PROXY_BASE_URL",
            "RUNTIME_AGENT_BUILD_TARGET",
            "RUNTIME_AGENT_FORCE_BUILD",
            "CODEX_SANDBOX_MODE",
            "INSTAFY_VNC_GEOMETRY",
        ] {
            assert!(!rendered.contains(key), "rendered user data retained {key}");
        }
        assert!(rendered.contains("INSTAFY_ENABLE_BROWSER_SESSION='1'"));
        assert!(rendered.contains("INSTAFY_BROWSER_CDP_SCREENCAST='1'"));
        assert!(rendered.contains("INSTAFY_VNC_PORT='5900'"));
        assert!(rendered.contains("RUNTIME_CPU_LIMIT='2'"));
        assert!(rendered.contains("RUNTIME_MEMORY_LIMIT='4g'"));
    }

    #[test]
    fn managed_webdev_rejects_wrong_generation() {
        let mut request = sample_request();
        request.provider = "instafy-cloud".to_string();
        request.metadata = Some(json!({
            "runtimeFlavor": "webdev",
            "_instafyManagedRuntimeLaunch": {
                "version": 1,
                "flavor": "webdev",
                "generation": Uuid::new_v4().to_string(),
            }
        }));

        assert!(render_runtime_user_data_template(
            "{{RUNTIME_AGENT_IMAGE}}",
            &request,
            Some("runtime-agent:base-sha"),
            Some("runtime-agent:webdev-sha"),
        )
        .is_err());
    }

    #[test]
    fn launch_without_request_or_provider_image_fails_closed() {
        let mut request = sample_request();
        request.metadata = None;
        let error = resolve_runtime_agent_image_for_request(&request, None, None)
            .expect_err("missing image must fail");
        assert!(error
            .to_string()
            .contains("requires an explicit provider RUNTIME_AGENT_IMAGE"));

        assert_eq!(
            resolve_runtime_agent_image_for_request(
                &request,
                Some("registry.example/runtime@sha256:abc"),
                None,
            )
            .expect("provider image"),
            "registry.example/runtime@sha256:abc",
        );
    }

    /// Each placeholder kind, in the places a cloud-config template puts it: env flags and
    /// JSON in a runcmd plain scalar, exports in a block scalar.
    const ROUND_TRIP_TEMPLATE: &str = r#"#cloud-config
runcmd:
  - printf '%s\n' {{RUNTIME_ENV_FLAGS}}
  - printf '%s\n' '{{RUNTIME_METADATA_JSON}}' '{{ORIGIN_METADATA_JSON}}'
  - |
    {{RUNTIME_ENV_EXPORTS}}
    printf '%s\n' "$CODEX_MODEL"
"#;

    /// A request value comes back unchanged through YAML and the shell, whatever it holds,
    /// and never changes the document around it: not with YAML (`: `, ` #`, quotes,
    /// indicators), not with the shell (quotes, `$( )`, backquotes, operators), not with
    /// Jinja (`{{`, `{%`, `{#`) and not with another placeholder.
    #[test]
    fn request_values_read_back_unchanged_through_yaml_and_the_shell() {
        let values = [
            "a: b",
            "a:",
            "key: value # comment",
            "a #b",
            "#a",
            "a\u{a0}#b",
            "{{RUNTIME_ENV_EXPORTS}}",
            "{{RUNTIME_TOKEN}}",
            "{% if true %}x{% endif %}",
            "{# note #}",
            "it's",
            "'",
            "''",
            "\"quoted\"",
            "back\\slash \\n",
            "$(echo INJECTED)",
            "`echo INJECTED`",
            "${HOME}",
            ";echo INJECTED;",
            "&& echo INJECTED || echo INJECTED",
            "| echo INJECTED > /dev/null",
            "* ? [a] ~",
            "- item",
            "? key",
            "&anchor *alias !tag @at `tick",
            "%YAML 1.1",
            "---",
            "...",
            "ünïcødé ✓ 🚀",
            "trailing space ",
            " leading space",
            "--privileged",
        ];
        for value in values {
            let mut request = sample_request();
            request.metadata = Some(json!({
                "source": value,
                "env": { "CODEX_MODEL": value }
            }));
            request.origin_metadata = Some(json!({ "label": value }));
            let rendered = render_runtime_user_data_template(
                ROUND_TRIP_TEMPLATE,
                &request,
                Some(PROVIDER_IMAGE),
                None,
            )
            .expect("rendered user data");
            for jinja in ["{{", "{%", "{#"] {
                assert!(
                    !rendered.contains(jinja),
                    "{value:?} left {jinja}:\n{rendered}"
                );
            }
            let commands = runcmd(&rendered);
            assert_eq!(commands.len(), 3, "{value:?}:\n{rendered}");

            let flags = printed_flags(&sh(&commands[0]));
            assert_eq!(flag(&flags, "CODEX_MODEL"), Some(value), "{rendered}");
            let metadata: JsonValue =
                serde_json::from_str(flag(&flags, "RUNTIME_METADATA").expect("metadata"))
                    .expect("RUNTIME_METADATA is JSON");
            assert_eq!(Some(&metadata), request.metadata.as_ref());
            let origin_metadata: JsonValue =
                serde_json::from_str(flag(&flags, "ORIGIN_METADATA").expect("origin metadata"))
                    .expect("ORIGIN_METADATA is JSON");
            assert_eq!(Some(&origin_metadata), request.origin_metadata.as_ref());

            let printed = sh(&commands[1]);
            let json: Vec<JsonValue> = printed
                .lines()
                .map(|line| serde_json::from_str(line).expect("JSON placeholder"))
                .collect();
            assert_eq!(
                json,
                [
                    request.metadata.clone().unwrap(),
                    request.origin_metadata.clone().unwrap()
                ]
            );

            assert_eq!(sh(&commands[2]), format!("{value}\n"), "{rendered}");
        }
    }

    /// cloud-init reads a cloud-config template as YAML 1.1, where `\n`, `\r`, U+0085, U+2028
    /// and U+2029 all end a line. JSON keeps such characters escaped, but an env value is
    /// passed as it is, so a launch whose env value has one, or any control character,
    /// fails instead of rendering.
    #[test]
    fn a_line_break_or_control_character_in_an_env_value_fails_the_launch() {
        for value in [
            "a\nb",
            "a\rb",
            "a\u{85}b",
            "a\u{2028}b",
            "a\u{2029}b",
            "a\tb",
            "a\u{0}b",
            "\u{1b}[31m",
            "a\u{7f}",
            "\u{feff}a",
            "a\u{fffe}",
        ] {
            let mut request = sample_request();
            request.metadata = Some(json!({ "env": { "CODEX_MODEL": value } }));
            let error = render_runtime_user_data_template(
                ROUND_TRIP_TEMPLATE,
                &request,
                Some(PROVIDER_IMAGE),
                None,
            )
            .expect_err("a value with a line break must not render");
            assert!(error.to_string().contains("CODEX_MODEL"), "{error}");

            let mut request = sample_request();
            request.origin_mode = Some(value.to_string());
            let error = render_runtime_user_data_template(
                ROUND_TRIP_TEMPLATE,
                &request,
                Some(PROVIDER_IMAGE),
                None,
            )
            .expect_err("an origin mode with a line break must not render");
            assert!(error.to_string().contains("ORIGIN_MODE"), "{error}");
        }

        // Inside launch metadata the same characters are JSON escapes, which keep the
        // document as it was.
        let mut request = sample_request();
        request.metadata = Some(json!({
            "source": "x\nbootcmd:\n  - echo INJECTED\n#",
            "label": "x\u{2028}bootcmd:\u{2028}- echo INJECTED\u{85}\u{2029}",
            "env": { "INSTAFY_ENABLE_BROWSER_SESSION": "1" }
        }));
        let rendered = render_runtime_user_data_template(
            ROUND_TRIP_TEMPLATE,
            &request,
            Some(PROVIDER_IMAGE),
            None,
        )
        .expect("rendered user data");
        let commands = runcmd(&rendered);
        let flags = printed_flags(&sh(&commands[0]));
        let metadata: JsonValue =
            serde_json::from_str(flag(&flags, "RUNTIME_METADATA").expect("metadata"))
                .expect("RUNTIME_METADATA is JSON");
        assert_eq!(Some(&metadata), request.metadata.as_ref());
    }

    /// The token, origin mode, origin protocols and image go into a template as they are, so
    /// they must be plain words; a launch whose word is not fails instead of rendering.
    #[test]
    fn placeholders_taken_as_is_hold_only_plain_words() {
        let render = |template: &str, request: &EnsureRuntimeRequest, image: Option<&str>| {
            render_runtime_user_data_template(template, request, image, None)
        };
        let mut request = sample_request();
        request.metadata = None;
        request.runtime_token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-_A".to_string();
        request.origin_protocols = vec!["http".to_string(), "ws".to_string()];
        // No space before the image, which would take the env flags there.
        assert_eq!(
            render(
                "{{RUNTIME_TOKEN}}|{{ORIGIN_MODE}}|{{ORIGIN_PROTOCOLS}}|{{RUNTIME_AGENT_IMAGE}}",
                &request,
                Some(PROVIDER_IMAGE),
            )
            .expect("plain words"),
            format!("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-_A|hosted|http,ws|{PROVIDER_IMAGE}")
        );

        let mut mode = request.clone();
        mode.origin_mode = Some("hosted;echo INJECTED".to_string());
        assert!(render("{{ORIGIN_MODE}}", &mode, Some(PROVIDER_IMAGE)).is_err());
        // Quoted in an env flag, the same mode is only text.
        let flags = render(
            "printf '%s\\n' {{RUNTIME_ENV_FLAGS}}",
            &mode,
            Some(PROVIDER_IMAGE),
        )
        .expect("flags");
        assert_eq!(
            flag(&printed_flags(&sh(&flags)), "ORIGIN_MODE"),
            Some("hosted;echo INJECTED")
        );

        let mut protocols = request.clone();
        protocols.origin_protocols = vec!["http".to_string(), "$(echo INJECTED)".to_string()];
        assert!(render("{{ORIGIN_PROTOCOLS}}", &protocols, Some(PROVIDER_IMAGE)).is_err());

        let mut token = request.clone();
        token.runtime_token = "token$(echo INJECTED)".to_string();
        assert!(render("{{RUNTIME_TOKEN}}", &token, Some(PROVIDER_IMAGE)).is_err());

        // A request image that is not a plain reference is not used, as one with whitespace
        // never was: the provider's image applies, and without one the launch fails.
        for image in [
            "alpine;echo INJECTED",
            "alpine$(echo INJECTED)",
            "alpine|sh",
            "alpine:{{RUNTIME_TOKEN}}",
            "-v/:/host",
            "alpine:",
        ] {
            let mut requested = request.clone();
            requested.metadata = Some(json!({ "runtimeAgentImage": image }));
            assert_eq!(
                render("{{RUNTIME_AGENT_IMAGE}}", &requested, Some(PROVIDER_IMAGE))
                    .expect("provider image"),
                PROVIDER_IMAGE,
                "{image}"
            );
            assert!(render("{{RUNTIME_AGENT_IMAGE}}", &requested, None).is_err());
            // The provider's own image is checked the same way.
            assert!(render("{{RUNTIME_AGENT_IMAGE}}", &request, Some(image)).is_err());
        }
        let mut requested = request.clone();
        requested.metadata = Some(json!({
            "runtimeAgentImage": "registry.example:5000/team/runtime-agent:v1.2_3@sha256:abc"
        }));
        assert_eq!(
            render("{{RUNTIME_AGENT_IMAGE}}", &requested, Some(PROVIDER_IMAGE)).expect("image"),
            "registry.example:5000/team/runtime-agent:v1.2_3@sha256:abc"
        );
    }

    /// `{{RUNTIME_ENV_EXPORTS}}` runs in the server's boot shell, before the commands the
    /// template runs there, so a request for a provider other than exact instafy_cloud sets
    /// only the runtime container's own variables, and never one the allocator sets itself.
    #[test]
    fn a_request_sets_only_runtime_container_variables() {
        let host_settings = [
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "DOCKER_CONFIG",
            "DOCKER_CERT_PATH",
            "COMPOSE_FILE",
            "BUILDKIT_HOST",
            "PATH",
            "HOME",
            "TMPDIR",
            "IFS",
            "ENV",
            "BASH_ENV",
            "SHELLOPTS",
            "PS4",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "SSL_CERT_FILE",
            "GIT_DIR",
            "GIT_SSH_COMMAND",
            "RUNTIME_AGENT_IMAGE",
            "RUNTIME_AGENT_BUILD_TARGET",
            "INSTAFY_SHARED_BROWSER_APPROVAL_DIR",
            "CUSTOM_RUNTIME_SETTING",
        ];
        let allocator_set = [
            "SPACE_ID",
            "RUNTIME_ID",
            "RUNTIME_LEASE_ID",
            "RUNTIME_PROVIDER",
            "RUNTIME_ACCESS_TOKEN",
            "ORIGIN_INTERNAL_TOKEN",
            "ORIGIN_ID",
            "ORIGIN_LEASE_ID",
            "ORIGIN_MODE",
            "ORIGIN_PROTOCOLS",
            "ORIGIN_METADATA",
            "RUNTIME_METADATA",
        ];
        let mut env = serde_json::Map::new();
        for key in host_settings.iter().chain(&allocator_set) {
            env.insert(key.to_string(), json!("chosen"));
        }
        env.insert("CODEX_MODEL".to_string(), json!("chosen-model"));
        env.insert("INSTAFY_ENABLE_BROWSER_SESSION".to_string(), json!(true));
        env.insert(
            "ORIGIN_GIT_REMOTE_URL".to_string(),
            json!("https://git.example.test/space.git"),
        );
        env.insert("RUNTIME_CPU_LIMIT".to_string(), json!(2));

        for provider in [
            "hetzner",
            "external-http",
            "instafy-cloud-custom",
            "self-hosted",
        ] {
            let mut request = sample_request();
            request.provider = provider.to_string();
            request.metadata = Some(json!({ "env": env }));
            let rendered = render_runtime_user_data_template(
                ROUND_TRIP_TEMPLATE,
                &request,
                Some(PROVIDER_IMAGE),
                None,
            )
            .expect("rendered user data");
            let commands = runcmd(&rendered);

            let flags = printed_flags(&sh(&commands[0]));
            let mut keys: Vec<&str> = flags.iter().map(|(key, _)| key.as_str()).collect();
            keys.sort_unstable();
            let mut expected = allocator_set.to_vec();
            expected.extend([
                "CODEX_MODEL",
                "INSTAFY_ENABLE_BROWSER_SESSION",
                "ORIGIN_GIT_REMOTE_URL",
                "RUNTIME_CPU_LIMIT",
            ]);
            expected.sort_unstable();
            assert_eq!(keys, expected, "{provider}");
            for key in allocator_set {
                assert_ne!(flag(&flags, key), Some("chosen"), "{provider} {key}");
            }
            assert_eq!(flag(&flags, "CODEX_MODEL"), Some("chosen-model"));
            assert_eq!(flag(&flags, "INSTAFY_ENABLE_BROWSER_SESSION"), Some("1"));
            assert_eq!(flag(&flags, "RUNTIME_CPU_LIMIT"), Some("2"));

            let mut exported: Vec<&str> = commands[2]
                .lines()
                .filter_map(|line| line.strip_prefix("export "))
                .map(|line| line.split_once('=').expect("KEY=value").0)
                .collect();
            exported.sort_unstable();
            assert_eq!(exported, expected, "{provider}");
        }
    }

    /// Launch metadata can carry allocator settings such as the Hetzner API token, from a
    /// controller that copies a provider row's metadata in whole or from the caller. They must
    /// not ride along into user-data, which every process on the server can read from the
    /// metadata service.
    #[test]
    fn provider_configuration_in_a_launch_never_reaches_user_data() {
        let template = r#"#cloud-config
runcmd:
  - printf '%s\n' {{RUNTIME_ENV_FLAGS}}
  - printf '%s\n' '{{RUNTIME_METADATA_JSON}}'
  - |
    {{RUNTIME_ENV_EXPORTS}}
"#;
        for provider in ["hetzner", "instafy-cloud"] {
            let mut metadata = serde_json::Map::new();
            for key in crate::allocator::PROVIDER_CONFIG_METADATA_KEYS {
                metadata.insert(key.to_string(), json!(format!("provider-secret-{key}")));
            }
            metadata.insert(
                "env".to_string(),
                json!({ "INSTAFY_ENABLE_BROWSER_SESSION": "1" }),
            );
            let mut request = sample_request();
            request.provider = provider.to_string();
            request.metadata = Some(JsonValue::Object(metadata));
            let rendered =
                render_runtime_user_data_template(template, &request, Some(PROVIDER_IMAGE), None)
                    .expect("rendered user data");
            assert!(
                !rendered.contains("provider-secret"),
                "{provider}:\n{rendered}"
            );
            for key in crate::allocator::PROVIDER_CONFIG_METADATA_KEYS {
                assert!(!rendered.contains(key), "{provider} kept {key}");
            }
            let flags = printed_flags(&sh(&runcmd(&rendered)[0]));
            assert_eq!(flag(&flags, "INSTAFY_ENABLE_BROWSER_SESSION"), Some("1"));
        }
    }

    #[test]
    fn shell_quote_splits_pairs_yaml_or_jinja_would_read() {
        assert_eq!(
            shell_quote("a: b #c {{d}} {%e {#f it's"),
            "'a:'' b ''#c {''{d}} {''%e {''#f it'\"'\"'s'"
        );
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("plain"), "'plain'");
    }

    #[test]
    fn user_data_json_reads_back_as_the_same_value_in_inert_characters() {
        let every_ascii: String = (0u8..=0x7f).map(char::from).collect();
        let mut object = serde_json::Map::new();
        object.insert(
            every_ascii.clone(),
            json!([
                every_ascii,
                "\u{85}\u{2028}\u{2029}\u{feff}\u{fffe}\u{ffff}",
                "ünïcødé ✓ 🚀",
                1,
                -2.5,
                1e300,
                true,
                null,
                { "": {} },
                []
            ]),
        );
        let value = JsonValue::Object(object);
        let json = user_data_json(&value);
        assert_eq!(
            serde_json::from_str::<JsonValue>(&json).expect("JSON"),
            value
        );
        assert!(
            json.chars()
                .all(|ch| ch.is_ascii_alphanumeric() || " _.,/@+=-\\\"{}[]:".contains(ch)),
            "{json}"
        );
        for pair in [": ", " #", "{{", "{%", "{#", "'"] {
            assert!(!json.contains(pair), "{pair} in {json}");
        }
    }

    #[test]
    fn no_runtime_container_variable_is_one_docker_or_the_boot_shell_reads() {
        assert!(
            RUNTIME_CONTAINER_ENV_KEYS
                .windows(2)
                .all(|pair| pair[0] < pair[1]),
            "keep RUNTIME_CONTAINER_ENV_KEYS sorted and unique"
        );
        // Every name belongs to one of the runtime's own families or is one of CHECKED_NAMES,
        // checked one by one; no Docker tool, shell, loader or HTTP client takes a setting from
        // those families or names. Any other name needs the same check before it joins
        // CHECKED_NAMES: OTEL_*, SSH_AUTH_SOCK and TZ, for example, would fail it.
        const RUNTIME_FAMILIES: [&str; 5] =
            ["CODEX_", "INSTAFY_", "ORIGIN_", "RUNTIME_", "SUPABASE_"];
        const CHECKED_NAMES: [&str; 4] = [
            "OPENAI_BASE_URL",
            "PROXY_BASE_URL",
            "PROXY_TOKEN_TTL_SECONDS",
            "USE_PROXY_FOR_LLM",
        ];
        for key in RUNTIME_CONTAINER_ENV_KEYS {
            assert!(
                RUNTIME_FAMILIES
                    .iter()
                    .any(|family| key.starts_with(family))
                    || CHECKED_NAMES.contains(key),
                "{key} is outside the runtime's own variable families"
            );
            for prefix in [
                "DOCKER_",
                "COMPOSE_",
                "BUILDKIT_",
                "BUILDX_",
                "LD_",
                "DYLD_",
                "GIT_",
                "GO",
                "OTEL_",
                "SSH_",
                "SSL_",
                "XDG_",
                "BASH",
                "PS",
            ] {
                assert!(!key.starts_with(prefix), "{key}");
            }
            assert!(
                !matches!(
                    *key,
                    "PATH" | "HOME" | "TMPDIR" | "SHELL" | "ENV" | "IFS" | "CDPATH"
                ),
                "{key}"
            );
            assert!(!key.to_ascii_uppercase().ends_with("_PROXY"), "{key}");
        }
    }
}

#[async_trait]
impl RuntimeAllocator for HetznerRuntimeAllocator {
    async fn ensure_runtime(
        &self,
        request: EnsureRuntimeRequest,
    ) -> anyhow::Result<EnsureRuntimeOutcome> {
        let name = self.build_name(request.project_id, request.runtime_id);
        let user_data = self.render_user_data(&request)?;
        let mut labels = HashMap::new();
        labels.insert("project".to_string(), request.project_id.to_string());
        labels.insert("runtime".to_string(), request.runtime_id.to_string());
        labels.insert("lease".to_string(), request.lease_id.to_string());
        labels.insert("role".to_string(), "runtime".to_string());

        info!(
            project_id = %request.project_id,
            runtime_id = %request.runtime_id,
            lease_id = %request.lease_id,
            server_type = %self.server_type,
            image = %self.image,
            network_id = %self.network_id,
            firewall_id = %self.firewall_id,
            "hetzner runtime allocator creating server"
        );

        let server = self.create_server(&name, &user_data, &labels).await?;

        Ok(EnsureRuntimeOutcome {
            launched: true,
            message: Some(format!(
                "hetzner server {} created (id {})",
                server.name, server.id
            )),
        })
    }

    async fn stop_runtime(&self, project_id: Uuid, runtime_id: Uuid) -> anyhow::Result<()> {
        self.stop_runtime_if_lease(project_id, runtime_id, None)
            .await
    }

    async fn stop_runtime_if_lease(
        &self,
        project_id: Uuid,
        runtime_id: Uuid,
        lease_id: Option<Uuid>,
    ) -> anyhow::Result<()> {
        let name = self.build_name(project_id, runtime_id);
        self.delete_by_name(&name, lease_id).await?;
        Ok(())
    }
}
