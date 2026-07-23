use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value as JsonValue;
use uuid::Uuid;

use crate::allocator::RuntimeAllocatorKind;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProviderConfig {
    pub id: String,
    pub display_name: String,
    pub kind: RuntimeAllocatorKind,
    #[serde(default)]
    pub owner_org_id: Option<Uuid>,
    #[serde(default)]
    pub allowed_org_ids: Vec<Uuid>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub metadata: Option<JsonValue>,
}

#[derive(Clone, Debug)]
pub struct ProviderConfig {
    pub runtime_docker_compose_file: Option<PathBuf>,
    pub runtime_docker_service: String,
    pub runtime_docker_project_prefix: String,
    /// Upper bound for concurrent `docker compose` operations across all runtimes.
    /// Keeping this low improves stability on Docker Desktop under load.
    pub runtime_docker_max_concurrent_ops: usize,
    pub runtime_docker_repo_host: Option<PathBuf>,
    pub runtime_docker_codex_root: Option<PathBuf>,
    /// Default runtime image selected by the provider, never by a managed
    /// runtime request.
    pub runtime_agent_image: Option<String>,
    /// Deploy-pinned webdev image for controller-attested managed launches.
    pub runtime_agent_webdev_image: Option<String>,
    pub docker_pool_hosts: Vec<String>,
    pub docker_pool_auth_token: Option<String>,
    pub runtime_allocator_required: bool,
    pub hetzner_token: Option<String>,
    pub hetzner_server_type: Option<String>,
    pub hetzner_image: Option<String>,
    pub hetzner_location: Option<String>,
    pub hetzner_network_id: Option<u64>,
    pub hetzner_firewall_id: Option<u64>,
    pub hetzner_runtime_user_data: Option<String>,
    pub runtime_providers: Vec<RuntimeProviderConfig>,
}

impl ProviderConfig {
    pub fn default_docker() -> Self {
        Self {
            runtime_docker_compose_file: None,
            runtime_docker_service: "runtime".to_string(),
            runtime_docker_project_prefix: "instafy-runtime-".to_string(),
            runtime_docker_max_concurrent_ops: 4,
            runtime_docker_repo_host: None,
            runtime_docker_codex_root: None,
            runtime_agent_image: None,
            runtime_agent_webdev_image: None,
            docker_pool_hosts: vec![],
            docker_pool_auth_token: None,
            runtime_allocator_required: true,
            hetzner_token: None,
            hetzner_server_type: None,
            hetzner_image: None,
            hetzner_location: None,
            hetzner_network_id: None,
            hetzner_firewall_id: None,
            hetzner_runtime_user_data: None,
            runtime_providers: vec![],
        }
    }

    pub fn from_env() -> Self {
        let mut config = Self::default_docker();

        if let Ok(path) = std::env::var("DOCKER_COMPOSE_FILE") {
            if !path.trim().is_empty() {
                config.runtime_docker_compose_file = Some(path.into());
            }
        }
        if let Ok(service) = std::env::var("DOCKER_SERVICE") {
            if !service.trim().is_empty() {
                config.runtime_docker_service = service;
            }
        }
        if let Ok(prefix) = std::env::var("DOCKER_PROJECT_PREFIX") {
            if !prefix.trim().is_empty() {
                config.runtime_docker_project_prefix = prefix;
            }
        }
        if let Ok(raw) = std::env::var("DOCKER_MAX_CONCURRENT_OPS") {
            if let Ok(value) = raw.trim().parse::<usize>() {
                if value > 0 {
                    config.runtime_docker_max_concurrent_ops = value;
                }
            }
        }
        if let Ok(repo) = std::env::var("DOCKER_REPO_HOST") {
            if !repo.trim().is_empty() {
                config.runtime_docker_repo_host = Some(repo.into());
            }
        }
        if let Ok(codex) = std::env::var("DOCKER_CODEX_ROOT") {
            if !codex.trim().is_empty() {
                config.runtime_docker_codex_root = Some(codex.into());
            }
        }

        config.runtime_agent_image = std::env::var("RUNTIME_AGENT_IMAGE")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());
        config.runtime_agent_webdev_image = std::env::var("RUNTIME_AGENT_WEBDEV_IMAGE")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());

        if let Ok(hosts) = std::env::var("DOCKER_POOL_HOSTS") {
            config.docker_pool_hosts = hosts
                .split(',')
                .map(|entry| entry.trim().trim_end_matches('/'))
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
                .collect();
        }

        config.docker_pool_auth_token = std::env::var("DOCKER_POOL_AUTH_TOKEN")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());

        if let Ok(required) = std::env::var("RUNTIME_ALLOCATOR_REQUIRED") {
            let value = required.trim().to_ascii_lowercase();
            config.runtime_allocator_required = value == "1" || value == "true" || value == "yes";
        }

        config.hetzner_token = std::env::var("HETZNER_TOKEN")
            .or_else(|_| std::env::var("HCLOUD_TOKEN"))
            .ok()
            .filter(|value| !value.trim().is_empty());
        config.hetzner_server_type = std::env::var("HETZNER_SERVER_TYPE").ok();
        config.hetzner_image = std::env::var("HETZNER_IMAGE").ok();
        config.hetzner_location = std::env::var("HETZNER_LOCATION").ok();
        config.hetzner_network_id = std::env::var("HETZNER_NETWORK_ID")
            .ok()
            .and_then(|raw| raw.parse().ok());
        config.hetzner_firewall_id = std::env::var("HETZNER_FIREWALL_ID")
            .ok()
            .and_then(|raw| raw.parse().ok());
        config.hetzner_runtime_user_data = std::env::var("HETZNER_USER_DATA").ok();

        config
    }
}
