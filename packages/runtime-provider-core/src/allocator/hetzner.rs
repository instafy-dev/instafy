use std::collections::HashMap;
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
#[allow(dead_code)]
struct HetznerServer {
    id: u64,
    name: String,
    #[serde(default)]
    labels: HashMap<String, String>,
    #[serde(default)]
    public_net: Option<HetznerPublicNet>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct HetznerPublicNet {
    #[serde(default)]
    ipv4: Option<HetznerIp>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct HetznerIp {
    ip: String,
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

    let runtime_env = build_runtime_env(request);
    let runtime_env_flags = build_shell_env_flags(&runtime_env);
    let runtime_env_exports = build_shell_env_exports(&runtime_env);
    let process_metadata =
        runtime_metadata_for_process(&request.provider, request.metadata.as_ref());

    let mut data = template.to_string();
    if !runtime_env_flags.is_empty() && !template.contains("{{RUNTIME_ENV_FLAGS}}") {
        // Backward-compatible fallback: if the user-data template does not include
        // `{{RUNTIME_ENV_FLAGS}}`, inject runtime env flags just before the runtime image token.
        let image_token = " {{RUNTIME_AGENT_IMAGE}}";
        let replacement = format!(" {} {{RUNTIME_AGENT_IMAGE}}", runtime_env_flags);
        data = data.replace(image_token, &replacement);
    }

    let replacements = vec![
        ("{{PROJECT_ID}}", request.project_id.to_string()),
        ("{{RUNTIME_ID}}", request.runtime_id.to_string()),
        ("{{LEASE_ID}}", request.lease_id.to_string()),
        ("{{RUNTIME_TOKEN}}", request.runtime_token.clone()),
        ("{{RUNTIME_AGENT_IMAGE}}", runtime_image),
        (
            "{{ORIGIN_INSTANCE_ID}}",
            request
                .origin_instance_id
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
        (
            "{{ORIGIN_MODE}}",
            request.origin_mode.clone().unwrap_or_default(),
        ),
        ("{{ORIGIN_PROTOCOLS}}", request.origin_protocols.join(",")),
        (
            "{{ORIGIN_METADATA_JSON}}",
            request
                .origin_metadata
                .as_ref()
                .map(JsonValue::to_string)
                .unwrap_or_default(),
        ),
        (
            "{{RUNTIME_METADATA_JSON}}",
            process_metadata
                .as_ref()
                .map(JsonValue::to_string)
                .unwrap_or_default(),
        ),
        ("{{RUNTIME_ENV_FLAGS}}", runtime_env_flags.clone()),
        ("{{RUNTIME_ENV_EXPORTS}}", runtime_env_exports),
    ];

    for (k, v) in replacements {
        data = data.replace(k, &v);
    }

    Ok(data)
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

fn build_runtime_env(request: &EnsureRuntimeRequest) -> Vec<(String, String)> {
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
        env.push(("ORIGIN_METADATA".to_string(), origin_metadata.to_string()));
    }
    let process_metadata =
        runtime_metadata_for_process(&request.provider, request.metadata.as_ref());
    if let Some(metadata) = process_metadata.as_ref() {
        env.push(("RUNTIME_METADATA".to_string(), metadata.to_string()));
        env.extend(metadata_env_pairs(
            metadata,
            is_exact_managed_provider(&request.provider),
        ));
    }

    env
}

fn metadata_env_pairs(metadata: &JsonValue, exact_managed_provider: bool) -> Vec<(String, String)> {
    let env_map = metadata
        .as_object()
        .and_then(|obj| obj.get("env"))
        .and_then(JsonValue::as_object);
    let Some(env_map) = env_map else {
        return Vec::new();
    };

    let mut entries = Vec::new();
    for (key, value) in env_map {
        if exact_managed_provider
            && (!is_allowed_managed_runtime_env_key(key)
                || canonical_managed_runtime_env_value(value).is_none())
        {
            continue;
        }
        if !is_valid_env_key(key) {
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
            other => other.to_string(),
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

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn build_shell_env_flags(values: &[(String, String)]) -> String {
    values
        .iter()
        .map(|(key, value)| format!("-e {}={}", key, shell_quote(value)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_shell_env_exports(values: &[(String, String)]) -> String {
    values
        .iter()
        .map(|(key, value)| format!("export {}={}", key, shell_quote(value)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn resolve_runtime_agent_image(metadata: &serde_json::Value) -> Option<String> {
    let meta = metadata.as_object()?;
    let raw = meta
        .get("runtimeAgentImage")
        .or_else(|| meta.get("runtime_agent_image"))
        .or_else(|| meta.get("runtime-agent-image"))
        .and_then(|value| value.as_str())?;

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() > 512 {
        return None;
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == '\\')
    {
        return None;
    }

    Some(trimmed.to_string())
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

    #[test]
    fn render_injects_env_flags_before_runtime_image_placeholder() {
        let template = r#"#cloud-config
runcmd:
  - docker run -d --name instafy-runtime --restart unless-stopped {{RUNTIME_AGENT_IMAGE}}
"#;
        let rendered = render_runtime_user_data_template(template, &sample_request(), None, None)
            .expect("rendered user data");
        assert!(rendered.contains("-e INSTAFY_ENABLE_BROWSER_SESSION='1'"));
        assert!(rendered.contains("-e INSTAFY_VNC_PORT='5900'"));
        assert!(rendered.contains("-e DOCKER_HOST='tcp://custom-docker.test:2375'"));
        assert!(rendered.contains("-e CUSTOM_RUNTIME_SETTING='preserved'"));
        assert!(rendered.contains("ghcr.io/instafy-dev/instafy-runtime-agent:webdev"));
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
