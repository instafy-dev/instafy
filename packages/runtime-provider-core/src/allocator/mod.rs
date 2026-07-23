use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

mod docker;
mod docker_pool;
mod external_http;
mod hetzner;
mod noop;

pub use docker::DockerRuntimeAllocator;
pub use docker_pool::DockerPoolRuntimeAllocator;
pub use hetzner::HetznerRuntimeAllocator;
pub use noop::NoopRuntimeAllocator;

use crate::config::{ProviderConfig, RuntimeProviderConfig};

pub(crate) const MANAGED_RUNTIME_FLAVOR_KEY: &str = "runtimeFlavor";
pub(crate) const MANAGED_RUNTIME_WEBDEV_FLAVOR: &str = "webdev";
pub(crate) const MANAGED_RUNTIME_LAUNCH_ATTESTATION: &str = "_instafyManagedRuntimeLaunch";

/// Exact-managed metadata is passed to an allocator that invokes Docker,
/// Compose or a cloud-init shell. Only variables intended for the isolated
/// runtime container may cross that process boundary; in particular, Docker,
/// Compose, BuildKit, shell path/config and proxy variables must never be
/// inherited from a request.
pub(crate) fn is_allowed_managed_runtime_env_key(key: &str) -> bool {
    matches!(
        key,
        // Server-derived resource and workspace settings.
        "RUNTIME_CPU_LIMIT"
            | "RUNTIME_MEMORY_LIMIT"
            | "ORIGIN_GIT_REMOTE_URL"
            // Shared Browser launch/render settings.
            | "INSTAFY_ENABLE_BROWSER_SESSION"
            | "INSTAFY_BROWSER_VIEWPORT_ONLY"
            | "INSTAFY_BROWSER_RENDER_SCALE"
            | "INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS"
            | "INSTAFY_BROWSER_CDP_SCREENCAST"
            | "INSTAFY_BROWSER_WEBRTC_ENABLED"
            | "INSTAFY_BROWSER_PREFERRED_VIEWER"
            | "INSTAFY_BROWSER_DISPLAY"
            | "INSTAFY_VNC_HOST"
            | "INSTAFY_VNC_PORT"
            | "INSTAFY_VNC_GEOMETRY"
            | "INSTAFY_VNC_DEPTH"
            // Controller/provider-owned browser policy. The public controller
            // strips these first; they can be added only after that boundary.
            | "INSTAFY_BROWSER_PROFILE_PERSIST"
            | "INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS"
            | "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"
            | "INSTAFY_BROWSER_WEBRTC_SENDER_URL"
            | "INSTAFY_BROWSER_WEBRTC_BIND"
            | "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"
            | "INSTAFY_BROWSER_WEBRTC_FPS"
            | "INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS"
            | "INSTAFY_BROWSER_EGRESS_ISOLATION"
            | "INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV"
            | "INSTAFY_BROWSER_EGRESS_PROXY_BIND"
            | "INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS"
            | "INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS"
    )
}

pub(crate) fn canonical_managed_runtime_env_value(value: &JsonValue) -> Option<JsonValue> {
    let rendered = match value {
        JsonValue::String(value) => value.clone(),
        JsonValue::Number(value) => value.to_string(),
        JsonValue::Bool(value) => {
            if *value {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        JsonValue::Null | JsonValue::Array(_) | JsonValue::Object(_) => return None,
    };
    Some(JsonValue::String(rendered))
}

pub(crate) fn is_exact_managed_provider(provider: &str) -> bool {
    let normalized = provider
        .trim()
        .to_ascii_lowercase()
        .split(|character: char| character == '-' || character == '_' || character.is_whitespace())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    normalized == "instafy_cloud"
}

pub(crate) fn managed_webdev_generation_matches(
    metadata: Option<&JsonValue>,
    lease_id: Uuid,
) -> bool {
    let Some(attestation) = metadata
        .and_then(JsonValue::as_object)
        .and_then(|root| root.get(MANAGED_RUNTIME_LAUNCH_ATTESTATION))
        .and_then(JsonValue::as_object)
    else {
        return false;
    };
    attestation.get("version").and_then(JsonValue::as_u64) == Some(1)
        && attestation.get("flavor").and_then(JsonValue::as_str)
            == Some(MANAGED_RUNTIME_WEBDEV_FLAVOR)
        && attestation
            .get("generation")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
            == Some(lease_id)
}

pub(crate) fn runtime_metadata_for_process(
    provider: &str,
    metadata: Option<&JsonValue>,
) -> Option<JsonValue> {
    let mut metadata = metadata?.clone();
    if !is_exact_managed_provider(provider) {
        return Some(metadata);
    }
    let Some(root) = metadata.as_object_mut() else {
        return Some(metadata);
    };
    for key in [
        "runtimeAgentImage",
        "runtime_agent_image",
        "runtime-agent-image",
    ] {
        root.remove(key);
    }
    if let Some(env) = root.get_mut("env").and_then(JsonValue::as_object_mut) {
        env.retain(|key, value| {
            if !is_allowed_managed_runtime_env_key(key) {
                return false;
            }
            let Some(canonical) = canonical_managed_runtime_env_value(value) else {
                return false;
            };
            *value = canonical;
            true
        });
    } else {
        root.remove("env");
    }
    Some(metadata)
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeAllocatorKind {
    Noop,
    Docker,
    DockerPool,
    Hetzner,
    ExternalHttp,
}

impl RuntimeAllocatorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RuntimeAllocatorKind::Noop => "noop",
            RuntimeAllocatorKind::Docker => "docker",
            RuntimeAllocatorKind::DockerPool => "docker_pool",
            RuntimeAllocatorKind::Hetzner => "hetzner",
            RuntimeAllocatorKind::ExternalHttp => "external_http",
        }
    }

    pub fn from_str(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "docker" => RuntimeAllocatorKind::Docker,
            "docker_pool" | "docker-pool" | "dockerpool" => RuntimeAllocatorKind::DockerPool,
            "hetzner" => RuntimeAllocatorKind::Hetzner,
            "external_http" | "external-http" | "http" => RuntimeAllocatorKind::ExternalHttp,
            _ => RuntimeAllocatorKind::Noop,
        }
    }

    pub fn from_env(raw: Option<String>) -> Self {
        raw.map(|value| RuntimeAllocatorKind::from_str(&value))
            .unwrap_or(RuntimeAllocatorKind::Noop)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct EnsureRuntimeRequest {
    pub project_id: Uuid,
    pub runtime_id: Uuid,
    pub lease_id: Uuid,
    pub provider: String,
    pub runtime_token: String,
    pub metadata: Option<JsonValue>,
    pub origin_instance_id: Option<Uuid>,
    pub origin_mode: Option<String>,
    pub origin_protocols: Vec<String>,
    pub origin_metadata: Option<JsonValue>,
}

#[derive(Clone, Debug, Default)]
pub struct EnsureRuntimeOutcome {
    #[allow(dead_code)]
    pub(crate) launched: bool,
    pub message: Option<String>,
}

#[async_trait]
pub trait RuntimeAllocator: Send + Sync {
    async fn ensure_runtime(
        &self,
        request: EnsureRuntimeRequest,
    ) -> anyhow::Result<EnsureRuntimeOutcome>;

    async fn stop_runtime(&self, project_id: Uuid, runtime_id: Uuid) -> anyhow::Result<()> {
        let _ = (project_id, runtime_id);
        Ok(())
    }

    /// Stop a runtime only when the provider still observes the requested
    /// lease generation. Allocators that cannot inspect generations retain the
    /// legacy behavior by default; generation-aware allocators override this
    /// method so a delayed release for lease L1 cannot destroy successor L2.
    async fn stop_runtime_if_lease(
        &self,
        project_id: Uuid,
        runtime_id: Uuid,
        lease_id: Option<Uuid>,
    ) -> anyhow::Result<()> {
        let _ = lease_id;
        self.stop_runtime(project_id, runtime_id).await
    }

    /// Whether the runtime's container died to the kernel OOM killer.
    /// `None` means unknown or unsupported by this allocator. Used to turn a
    /// silent SIGKILL into an attributed "needed more memory" message.
    async fn runtime_oom_killed(
        &self,
        project_id: Uuid,
        runtime_id: Uuid,
    ) -> anyhow::Result<Option<bool>> {
        let _ = (project_id, runtime_id);
        Ok(None)
    }
}

pub type DynRuntimeAllocator = Arc<dyn RuntimeAllocator>;

#[allow(dead_code)]
pub fn build_runtime_allocator(config: &ProviderConfig) -> anyhow::Result<DynRuntimeAllocator> {
    let provider = config
        .runtime_providers
        .first()
        .cloned()
        .unwrap_or(RuntimeProviderConfig {
            id: "default".to_string(),
            display_name: "Default".to_string(),
            kind: RuntimeAllocatorKind::Noop,
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        });
    build_runtime_allocator_for_kind(config, &provider)
}

fn apply_provider_overrides(
    config: &ProviderConfig,
    provider: &RuntimeProviderConfig,
) -> ProviderConfig {
    let mut cfg = config.clone();
    let meta = match provider.metadata.as_ref() {
        Some(value) => value,
        None => return cfg,
    };

    let string = |key: &str| meta.get(key).and_then(|v| v.as_str()).map(str::to_string);
    if let Some(path) = string("dockerComposeFile") {
        cfg.runtime_docker_compose_file = Some(PathBuf::from(path));
    }
    if let Some(service) = string("dockerService") {
        cfg.runtime_docker_service = service;
    }
    if let Some(prefix) = string("dockerProjectPrefix") {
        cfg.runtime_docker_project_prefix = prefix;
    }
    if let Some(repo) = string("dockerRepoHost") {
        cfg.runtime_docker_repo_host = Some(PathBuf::from(repo));
    }
    if let Some(codex) = string("dockerCodexRoot") {
        cfg.runtime_docker_codex_root = Some(PathBuf::from(codex));
    }

    if let Some(token) = string("hetznerToken") {
        cfg.hetzner_token = Some(token);
    }
    if let Some(server_type) = string("hetznerServerType") {
        cfg.hetzner_server_type = Some(server_type);
    }
    if let Some(image) = string("hetznerImage") {
        cfg.hetzner_image = Some(image);
    }
    if let Some(location) = string("hetznerLocation") {
        cfg.hetzner_location = Some(location);
    }
    if let Some(network) = meta.get("hetznerNetworkId").and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    }) {
        cfg.hetzner_network_id = Some(network);
    }
    if let Some(firewall) = meta.get("hetznerFirewallId").and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    }) {
        cfg.hetzner_firewall_id = Some(firewall);
    }
    if let Some(user_data) = string("hetznerUserData") {
        cfg.hetzner_runtime_user_data = Some(user_data);
    }

    cfg
}

pub fn build_runtime_allocator_for_kind(
    config: &ProviderConfig,
    provider: &crate::config::RuntimeProviderConfig,
) -> anyhow::Result<DynRuntimeAllocator> {
    let cfg = apply_provider_overrides(config, provider);
    let allocator: DynRuntimeAllocator = match provider.kind {
        RuntimeAllocatorKind::Noop => {
            if config.runtime_allocator_required {
                return Err(anyhow::anyhow!(
                    "RUNTIME_ALLOCATOR_REQUIRED is set but runtime allocator resolved to noop"
                ));
            }
            Arc::new(NoopRuntimeAllocator)
        }
        RuntimeAllocatorKind::Docker => match DockerRuntimeAllocator::new(&cfg) {
            Ok(inner) => Arc::new(inner),
            Err(error) => {
                if config.runtime_allocator_required {
                    return Err(anyhow::anyhow!(
                        "docker runtime allocator required but failed to initialize: {error}"
                    ));
                }
                tracing::warn!(%error, "failed to initialize docker runtime allocator; falling back to noop");
                Arc::new(NoopRuntimeAllocator)
            }
        },
        RuntimeAllocatorKind::DockerPool => match DockerPoolRuntimeAllocator::new(&cfg) {
            Ok(inner) => Arc::new(inner),
            Err(error) => {
                if config.runtime_allocator_required {
                    return Err(anyhow::anyhow!(
                        "docker pool allocator required but failed to initialize: {error}"
                    ));
                }
                tracing::warn!(%error, "failed to initialize docker pool allocator; falling back to noop");
                Arc::new(NoopRuntimeAllocator)
            }
        },
        RuntimeAllocatorKind::Hetzner => match HetznerRuntimeAllocator::new(&cfg) {
            Ok(inner) => Arc::new(inner),
            Err(error) => {
                if config.runtime_allocator_required {
                    return Err(anyhow::anyhow!(
                        "hetzner runtime allocator required but failed to initialize: {error}"
                    ));
                }
                tracing::warn!(%error, "failed to initialize hetzner runtime allocator; falling back to noop");
                Arc::new(NoopRuntimeAllocator)
            }
        },
        RuntimeAllocatorKind::ExternalHttp => {
            match external_http::ExternalHttpRuntimeAllocator::new(provider) {
                Ok(inner) => Arc::new(inner),
                Err(error) => {
                    if config.runtime_allocator_required {
                        return Err(anyhow::anyhow!(
                            "external runtime provider required but failed to initialize: {error}"
                        ));
                    }
                    tracing::warn!(%error, provider_id = %provider.id, "failed to initialize external runtime provider; falling back to noop");
                    Arc::new(NoopRuntimeAllocator)
                }
            }
        }
    };
    Ok(allocator)
}

pub(crate) fn default_compose_file() -> std::path::PathBuf {
    std::path::PathBuf::from("docker/docker-compose.runtime.yml")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ProviderConfig, RuntimeProviderConfig};
    use anyhow::Context;
    use serde_json::json;

    fn base_config() -> ProviderConfig {
        let mut config = ProviderConfig::default_docker();
        config.runtime_allocator_required = false;
        config
    }

    #[test]
    fn it_applies_hetzner_metadata_overrides() {
        let mut base = base_config();
        base.runtime_providers = vec![RuntimeProviderConfig {
            id: "hetzner".to_string(),
            display_name: "Hetzner".to_string(),
            kind: RuntimeAllocatorKind::Hetzner,
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: Some(json!({
                "hetznerToken": "secret-token",
                "hetznerServerType": "cpx11",
                "hetznerImage": "ubuntu-22.04",
                "hetznerLocation": "hel1",
                "hetznerNetworkId": 12345,
                "hetznerFirewallId": "67890",
                "hetznerUserData": "#cloud-config\nruncmd: []\n"
            })),
        }];

        let provider = base.runtime_providers[0].clone();
        let cfg = apply_provider_overrides(&base, &provider);

        assert_eq!(cfg.hetzner_token.as_deref(), Some("secret-token"));
        assert_eq!(cfg.hetzner_server_type.as_deref(), Some("cpx11"));
        assert_eq!(cfg.hetzner_image.as_deref(), Some("ubuntu-22.04"));
        assert_eq!(cfg.hetzner_location.as_deref(), Some("hel1"));
        assert_eq!(cfg.hetzner_network_id, Some(12345));
        assert_eq!(cfg.hetzner_firewall_id, Some(67890));
        assert_eq!(
            cfg.hetzner_runtime_user_data.as_deref(),
            Some("#cloud-config\nruncmd: []\n")
        );
    }

    #[tokio::test]
    async fn hetzner_live_smoke_creates_and_deletes_server() -> anyhow::Result<()> {
        // Opt-in only: set HETZNER_SMOKE=1 and required env vars.
        if std::env::var("HETZNER_SMOKE").unwrap_or_default() != "1" {
            return Ok(());
        }

        let token = match std::env::var("HCLOUD_TOKEN").or_else(|_| std::env::var("HETZNER_TOKEN"))
        {
            Ok(v) if !v.is_empty() => v,
            _ => anyhow::bail!("HETZNER_SMOKE=1 requires HCLOUD_TOKEN or HETZNER_TOKEN"),
        };
        let network_id: u64 = std::env::var("HETZNER_NETWORK_ID")?
            .parse()
            .context("parse HETZNER_NETWORK_ID")?;
        let firewall_id: u64 = std::env::var("HETZNER_FIREWALL_ID")?
            .parse()
            .context("parse HETZNER_FIREWALL_ID")?;
        let server_type = std::env::var("HETZNER_SERVER_TYPE").unwrap_or_else(|_| "cpx11".into());
        let image = std::env::var("HETZNER_IMAGE").unwrap_or_else(|_| "ubuntu-22.04".into());
        let location = std::env::var("HETZNER_LOCATION").unwrap_or_else(|_| "hel1".into());

        let mut base = base_config();
        base.runtime_docker_project_prefix = "instafy-smoke-".to_string();
        base.hetzner_token = Some(token);
        base.hetzner_network_id = Some(network_id);
        base.hetzner_firewall_id = Some(firewall_id);
        base.hetzner_server_type = Some(server_type);
        base.hetzner_image = Some(image);
        base.hetzner_location = Some(location);
        base.hetzner_runtime_user_data =
            Some("#cloud-config\nruncmd:\n  - echo 'smoke'\n".to_string());

        let allocator = HetznerRuntimeAllocator::new(&base)?;
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let req = EnsureRuntimeRequest {
            project_id,
            runtime_id,
            lease_id,
            provider: "hetzner".to_string(),
            runtime_token: "smoke-token".to_string(),
            metadata: None,
            origin_instance_id: None,
            origin_mode: Some("hosted".to_string()),
            origin_protocols: vec!["http".to_string()],
            origin_metadata: None,
        };

        let outcome = allocator.ensure_runtime(req).await?;
        assert!(outcome.launched, "server should be launched");

        // Best-effort cleanup; ignore errors to avoid masking creation success.
        let _ = allocator.stop_runtime(project_id, runtime_id).await;
        Ok(())
    }
}
