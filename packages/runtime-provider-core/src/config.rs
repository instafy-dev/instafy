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
    /// For a provider other than exact instafy_cloud, a launch request's
    /// `metadata.runtimeAgentImage` picks the runtime image in place of
    /// `runtime_agent_image` (`RUNTIME_AGENT_IMAGE_FROM_REQUEST`, off by
    /// default). Whoever launches then chooses the code that runs every
    /// member's turns on the runtime.
    pub runtime_agent_image_from_request: bool,
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
    /// When the Docker allocator evicts stopped workspace checkouts from the
    /// node's disk (`RUNTIME_CHECKOUT_TTL_DAYS`, default 7, 0 turns idle
    /// eviction off; `RUNTIME_CHECKOUT_DISK_BUDGET_GIB`, unset or 0 for no
    /// budget).
    pub runtime_checkout_eviction: crate::allocator::CheckoutEvictionPolicy,
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
            runtime_agent_image_from_request: false,
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
            runtime_checkout_eviction: crate::allocator::CheckoutEvictionPolicy::default(),
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
        if let Ok(raw) = std::env::var("RUNTIME_AGENT_IMAGE_FROM_REQUEST") {
            config.runtime_agent_image_from_request = is_truthy(&raw);
        }

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
            config.runtime_allocator_required = is_truthy(&required);
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

        if let Ok(raw) = std::env::var("RUNTIME_CHECKOUT_TTL_DAYS") {
            if let Ok(days) = raw.trim().parse::<u64>() {
                config.runtime_checkout_eviction.idle_ttl =
                    (days > 0).then(|| std::time::Duration::from_secs(days * 24 * 60 * 60));
            }
        }
        if let Ok(raw) = std::env::var("RUNTIME_CHECKOUT_DISK_BUDGET_GIB") {
            if let Ok(gib) = raw.trim().parse::<u64>() {
                config.runtime_checkout_eviction.disk_budget_bytes =
                    (gib > 0).then(|| gib.saturating_mul(1024 * 1024 * 1024));
            }
        }

        config
    }
}

/// `1`, `true` or `yes`, in any case and with surrounding whitespace.
fn is_truthy(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A launch request picks a custom provider's image only where its operator opts in.
    #[test]
    fn requests_pick_no_image_unless_the_operator_opts_in() {
        assert!(!ProviderConfig::default_docker().runtime_agent_image_from_request);
        for raw in ["1", "true", "TRUE", " yes ", "Yes", "\ttrue\n"] {
            assert!(is_truthy(raw), "{raw:?}");
        }
        for raw in [
            "", " ", "0", "false", "no", "off", "on", "2", "y", "enabled", "1 1", "truthy",
        ] {
            assert!(!is_truthy(raw), "{raw:?}");
        }
    }

    /// The provider service reads its opt-in from `RUNTIME_AGENT_IMAGE_FROM_REQUEST`. Nothing
    /// else in the tests reads that variable.
    #[test]
    fn the_image_opt_in_comes_from_the_provider_services_environment() {
        const NAME: &str = "RUNTIME_AGENT_IMAGE_FROM_REQUEST";
        let previous = std::env::var_os(NAME);
        let read = |value: Option<&str>| {
            match value {
                Some(value) => std::env::set_var(NAME, value),
                None => std::env::remove_var(NAME),
            }
            ProviderConfig::from_env().runtime_agent_image_from_request
        };
        let results = [read(Some("1")), read(Some("0")), read(None)];
        match previous {
            Some(value) => std::env::set_var(NAME, value),
            None => std::env::remove_var(NAME),
        }
        assert_eq!(results, [true, false, false]);
    }
}
