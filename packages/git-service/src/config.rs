use std::path::PathBuf;

use anyhow::{Context, Result};
use reqwest::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitEdgeRoutingMode {
    Hash,
    Controller,
}

#[derive(Clone, Debug)]
pub struct GitEdgeConfig {
    pub bind_host: String,
    pub bind_port: u16,
    pub skip_auth: bool,
    pub jwks_url: Url,
    pub audience: String,
    pub shards: Vec<Url>,
    pub routing_mode: GitEdgeRoutingMode,
    pub controller_url: Option<Url>,
    pub controller_token: Option<String>,
    pub route_cache_seconds: u64,
}

impl GitEdgeConfig {
    pub fn from_env() -> Result<Self> {
        let bind_host =
            std::env::var("GIT_EDGE_BIND_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let bind_port = std::env::var("GIT_EDGE_BIND_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8080);
        let skip_auth = matches!(
            std::env::var("GIT_EDGE_SKIP_AUTH")
                .unwrap_or_else(|_| "0".to_string())
                .as_str(),
            "1" | "true" | "yes" | "on"
        );
        let jwks_url_raw = std::env::var("GIT_JWKS_URL").unwrap_or_else(|_| {
            "http://host.docker.internal:8788/.well-known/jwks.json".to_string()
        });
        let jwks_url = Url::parse(&jwks_url_raw)
            .with_context(|| format!("invalid GIT_JWKS_URL={jwks_url_raw}"))?;
        let audience = std::env::var("GIT_AUDIENCE").unwrap_or_else(|_| "git".to_string());
        let shards_raw =
            std::env::var("GIT_SHARDS").unwrap_or_else(|_| "http://git-shard-0:8081".to_string());
        let shards = shards_raw
            .split(',')
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|value| {
                Url::parse(value).with_context(|| format!("invalid GIT_SHARDS entry: {value}"))
            })
            .collect::<Result<Vec<_>>>()?;
        if shards.is_empty() {
            anyhow::bail!("GIT_SHARDS must include at least one shard URL");
        }

        let routing_mode_raw =
            std::env::var("GIT_EDGE_ROUTING").unwrap_or_else(|_| "hash".to_string());
        let routing_mode = match routing_mode_raw.trim().to_ascii_lowercase().as_str() {
            "controller" | "controller_v1" => GitEdgeRoutingMode::Controller,
            _ => GitEdgeRoutingMode::Hash,
        };

        let controller_url = std::env::var("GIT_EDGE_CONTROLLER_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(|raw| {
                Url::parse(&raw).with_context(|| format!("invalid GIT_EDGE_CONTROLLER_URL={raw}"))
            })
            .transpose()?;

        let controller_token = std::env::var("GIT_EDGE_CONTROLLER_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let route_cache_seconds = std::env::var("GIT_EDGE_ROUTE_CACHE_SECONDS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(60);

        if routing_mode == GitEdgeRoutingMode::Controller && controller_url.is_none() {
            anyhow::bail!("GIT_EDGE_CONTROLLER_URL is required when GIT_EDGE_ROUTING=controller");
        }

        Ok(Self {
            bind_host,
            bind_port,
            skip_auth,
            jwks_url,
            audience,
            shards,
            routing_mode,
            controller_url,
            controller_token,
            route_cache_seconds,
        })
    }
}

#[derive(Clone, Debug)]
pub struct GitShardConfig {
    pub bind_host: String,
    pub bind_port: u16,
    pub repo_root: PathBuf,
    pub auto_init: bool,
    pub default_branch: String,
    pub events_webhook: Option<GitEventsWebhookConfig>,
}

#[derive(Clone, Debug)]
pub struct GitEventsWebhookConfig {
    pub url: Url,
    pub token: Option<String>,
    pub timeout_ms: u64,
}

impl GitShardConfig {
    pub fn from_env() -> Result<Self> {
        let bind_host =
            std::env::var("GIT_SHARD_BIND_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let bind_port = std::env::var("GIT_SHARD_BIND_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8081);
        let repo_root = std::env::var("GIT_REPO_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/var/lib/instafy-git/repos"));
        let auto_init = matches!(
            std::env::var("GIT_AUTO_INIT")
                .unwrap_or_else(|_| "0".to_string())
                .as_str(),
            "1" | "true" | "yes" | "on"
        );
        let default_branch =
            std::env::var("GIT_DEFAULT_BRANCH").unwrap_or_else(|_| "main".to_string());
        let events_webhook = std::env::var("GIT_EVENTS_WEBHOOK_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(|raw| -> Result<GitEventsWebhookConfig> {
                let url = Url::parse(&raw)
                    .with_context(|| format!("invalid GIT_EVENTS_WEBHOOK_URL={raw}"))?;
                let token = std::env::var("GIT_EVENTS_WEBHOOK_TOKEN")
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                let timeout_ms = std::env::var("GIT_EVENTS_WEBHOOK_TIMEOUT_MS")
                    .ok()
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .filter(|value| *value >= 100)
                    .unwrap_or(3_000);

                Ok(GitEventsWebhookConfig {
                    url,
                    token,
                    timeout_ms,
                })
            })
            .transpose()?;
        Ok(Self {
            bind_host,
            bind_port,
            repo_root,
            auto_init,
            default_branch,
            events_webhook,
        })
    }
}
