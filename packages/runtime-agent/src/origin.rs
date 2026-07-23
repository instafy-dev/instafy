use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration as StdDuration;

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};
use origin_http_server::config::ServerConfig;
use origin_http_server::server::OriginHttpServer;
use reqwest::Url;
use serde::Serialize;
use serde_json::{Map as JsonMap, Value};
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

use crate::config::{Config, OriginSettings};

#[derive(Clone, Debug)]
pub struct OriginTunnelSnapshot {
    pub provider: String,
    pub hostname: String,
    pub url: String,
    pub tunnel_id: String,
    pub status: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_rotation_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Default)]
pub struct OriginLaunchOverrides {
    pub tunnel: Option<OriginTunnelSnapshot>,
    pub controller_token: Option<String>,
}

pub struct OriginService {
    server: Option<OriginHttpServer>,
    presence_metadata: Option<Arc<RwLock<Value>>>,
}

impl OriginService {
    pub async fn try_start(
        config: Arc<Config>,
        overrides: Option<OriginLaunchOverrides>,
    ) -> Result<Option<Self>> {
        let mut settings = match &config.origin {
            Some(settings) => settings.clone(),
            None => return Ok(None),
        };

        if let Some(overrides) = overrides {
            if let Some(token) = overrides
                .controller_token
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                settings.controller_internal_token = Some(token.to_string());
            }
            if let Some(tunnel) = overrides.tunnel {
                settings.tunnel_provider = Some(tunnel.provider);
                settings.tunnel_hostname = Some(tunnel.hostname);
                settings.tunnel_url = Some(tunnel.url);
                settings.tunnel_id = Some(tunnel.tunnel_id);
                settings.tunnel_status = tunnel.status;
                settings.tunnel_expires_at = tunnel.expires_at;
                settings.tunnel_last_rotation_at = Some(tunnel.last_rotation_at);
            }
        }

        let controller_token = settings
            .controller_internal_token
            .clone()
            .ok_or_else(|| anyhow!("ORIGIN_INTERNAL_TOKEN must be set when origin is enabled"))?;

        let workspace_root = Self::resolve_workspace_root(&config)?;

        let server_config = ServerConfig {
            project_id: config.project_id,
            origin_id: settings.origin_id,
            workspace_root,
            git_remote_url: settings.git_remote_url.clone(),
            git_remote_base_url: None,
            git_branch: settings.git_branch.clone(),
            git_remote_name: settings.git_remote_name.clone(),
            git_author_name: settings.git_author_name.clone(),
            git_author_email: settings.git_author_email.clone(),
            bind_host: settings.bind_host.clone(),
            bind_port: settings.bind_port,
            controller_base_url: config.controller_base_url.clone(),
            controller_internal_token: Some(controller_token.clone()),
            jwks_url: settings.jwks_url.clone(),
            skip_auth: settings.skip_auth,
            enable_presence_heartbeat: settings.enable_presence_heartbeat,
            presence_interval: settings.presence_interval,
            max_archive_bytes: settings.max_archive_bytes,
            staging_base: settings.staging_root.clone(),
            multi_tenant: false,
        };

        let mut server = OriginHttpServer::new(server_config)?;
        let presence_metadata = compose_presence_metadata(&settings);
        server.set_presence_metadata(presence_metadata).await;
        let presence_handle = server.presence_metadata_handle();
        let start = server
            .start()
            .await
            .context("failed to start origin HTTP server")?;

        info!(
            address = %start.address,
            origin_id = %settings.origin_id,
            "origin HTTP server listening"
        );

        let endpoint = settings
            .tunnel_url
            .clone()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| settings.endpoint.clone())
            .unwrap_or_else(|| Self::derive_endpoint(start.address));

        let mut protocols = settings
            .protocols
            .iter()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect::<Vec<String>>();
        if protocols.is_empty() {
            protocols.push("http".to_string());
        }
        protocols.sort();
        protocols.dedup();

        let mode = match settings.mode.as_str() {
            "desktop" | "efs" | "hosted" => settings.mode.clone(),
            other => {
                warn!(
                    mode = %other,
                    "unsupported origin mode; defaulting to desktop"
                );
                "desktop".to_string()
            }
        };

        let enriched_metadata = compose_origin_metadata(&settings);

        if let Err(error) = Self::register_with_controller(
            &config.controller_base_url,
            &controller_token,
            RegisterOriginPayload {
                project_id: config.project_id,
                origin_id: settings.origin_id,
                mode: mode.clone(),
                endpoint: endpoint.clone(),
                protocols: protocols.clone(),
                region: settings.region.clone(),
                device_id: settings.device_id.clone(),
                metadata: enriched_metadata,
            },
        )
        .await
        {
            warn!(?error, "origin registration failed; stopping origin server");
            if let Err(stop_error) = server.stop().await {
                warn!(
                    ?stop_error,
                    "failed to stop origin server after registration failure"
                );
            }
            return Err(error.context("failed to register origin with controller"));
        }

        Ok(Some(Self {
            server: Some(server),
            presence_metadata: Some(presence_handle),
        }))
    }

    pub async fn shutdown(&mut self) {
        if let Some(server) = self.server.as_mut() {
            // Graceful machine shutdown: checkpoint uncommitted workspace
            // changes to the git remote before the container dies. The
            // registration-failure cleanup above deliberately uses the
            // non-flushing stop() — the controller is unreachable there and
            // no user work is at stake.
            if let Err(error) = server.stop_flushing_workspace().await {
                warn!(?error, "failed to stop origin HTTP server");
            } else {
                info!("origin HTTP server stopped");
            }
        }
        self.server = None;
        self.presence_metadata = None;
    }

    pub fn presence_metadata_handle(&self) -> Option<Arc<RwLock<Value>>> {
        self.presence_metadata.clone()
    }

    fn resolve_workspace_root(config: &Config) -> Result<PathBuf> {
        let folder = config.project_workspace_dir(&config.project_id);
        std::fs::create_dir_all(&folder).with_context(|| {
            format!("failed to ensure project workspace exists at {:?}", folder)
        })?;
        Ok(folder)
    }

    fn derive_endpoint(address: std::net::SocketAddr) -> String {
        let host = match address.ip() {
            IpAddr::V4(ipv4) if ipv4.is_unspecified() => "127.0.0.1".to_string(),
            IpAddr::V6(ipv6) if ipv6.is_unspecified() => "::1".to_string(),
            ip => ip.to_string(),
        };
        format!("http://{}:{}", host, address.port())
    }

    async fn register_with_controller(
        base_url: &Url,
        internal_token: &str,
        payload: RegisterOriginPayload,
    ) -> Result<()> {
        let client = reqwest::Client::builder()
            .timeout(StdDuration::from_secs(60))
            .build()
            .context("failed to build origin register client")?;
        let mut url = base_url.clone();
        url.path_segments_mut()
            .map_err(|_| anyhow!("controller base URL is not valid for registration"))?
            .extend(["origin", "register"]);

        let response = client
            .post(url)
            .bearer_auth(internal_token)
            .json(&payload)
            .send()
            .await
            .context("origin register request failed")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("origin register failed: status={} body={}", status, body);
        }

        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterOriginPayload {
    project_id: Uuid,
    origin_id: Uuid,
    mode: String,
    endpoint: String,
    protocols: Vec<String>,
    region: Option<String>,
    device_id: Option<String>,
    metadata: Option<Value>,
}

fn compose_origin_metadata(settings: &OriginSettings) -> Option<Value> {
    let mut root_map = match settings.metadata.clone() {
        Some(Value::Object(map)) => map,
        Some(other) => {
            let mut map = JsonMap::new();
            map.insert("legacyMetadata".to_string(), other);
            map
        }
        None => JsonMap::new(),
    };

    let mut tunnel = JsonMap::new();
    if let Some(provider) = settings.tunnel_provider.as_ref() {
        tunnel.insert("provider".to_string(), Value::String(provider.clone()));
    }
    if let Some(hostname) = settings.tunnel_hostname.as_ref() {
        tunnel.insert("hostname".to_string(), Value::String(hostname.clone()));
    }
    if let Some(url) = settings.tunnel_url.as_ref() {
        tunnel.insert("url".to_string(), Value::String(url.clone()));
    }
    if let Some(id) = settings.tunnel_id.as_ref() {
        tunnel.insert("id".to_string(), Value::String(id.clone()));
    }
    if let Some(status) = settings.tunnel_status.as_ref() {
        tunnel.insert("status".to_string(), Value::String(status.clone()));
    }
    if let Some(expires_at) = settings.tunnel_expires_at.as_ref() {
        tunnel.insert(
            "expiresAt".to_string(),
            Value::String(expires_at.to_rfc3339()),
        );
    }
    if let Some(last_rotation) = settings.tunnel_last_rotation_at.as_ref() {
        tunnel.insert(
            "lastRotationAt".to_string(),
            Value::String(last_rotation.to_rfc3339()),
        );
    }
    if !tunnel.is_empty() {
        root_map.insert("tunnel".to_string(), Value::Object(tunnel));
    }

    if root_map.is_empty() {
        None
    } else {
        Some(Value::Object(root_map))
    }
}

fn compose_presence_metadata(settings: &OriginSettings) -> Value {
    let mut root_map = JsonMap::new();
    root_map.insert(
        "source".to_string(),
        Value::String("origin-http-server".to_string()),
    );
    root_map.insert("mode".to_string(), Value::String(settings.mode.clone()));
    if let Some(region) = settings.region.as_ref() {
        root_map.insert("region".to_string(), Value::String(region.clone()));
    }
    if let Some(device_id) = settings.device_id.as_ref() {
        root_map.insert("deviceId".to_string(), Value::String(device_id.clone()));
    }

    let mut tunnel = JsonMap::new();
    if let Some(provider) = settings.tunnel_provider.as_ref() {
        tunnel.insert("provider".to_string(), Value::String(provider.clone()));
    }
    if let Some(hostname) = settings.tunnel_hostname.as_ref() {
        tunnel.insert("hostname".to_string(), Value::String(hostname.clone()));
    }
    if let Some(url) = settings.tunnel_url.as_ref() {
        tunnel.insert("url".to_string(), Value::String(url.clone()));
    }
    if let Some(id) = settings.tunnel_id.as_ref() {
        tunnel.insert("id".to_string(), Value::String(id.clone()));
    }
    if let Some(status) = settings.tunnel_status.as_ref() {
        tunnel.insert("status".to_string(), Value::String(status.clone()));
    }
    if let Some(expires_at) = settings.tunnel_expires_at.as_ref() {
        tunnel.insert(
            "expiresAt".to_string(),
            Value::String(expires_at.to_rfc3339()),
        );
    }
    if let Some(last_rotation) = settings.tunnel_last_rotation_at.as_ref() {
        tunnel.insert(
            "lastRotationAt".to_string(),
            Value::String(last_rotation.to_rfc3339()),
        );
    }
    if !tunnel.is_empty() {
        root_map.insert("tunnel".to_string(), Value::Object(tunnel));
    }

    Value::Object(root_map)
}
