use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use serde_json::Value;
use uuid::Uuid;

fn parse_env_bool(key: &str) -> Option<bool> {
    std::env::var(key).ok().map(|raw| {
        matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn normalize_lease_max_jobs(raw: Option<&str>, strict_mode: bool) -> u32 {
    let lease_max_jobs = raw
        .and_then(|value| value.parse::<u32>().ok())
        // Read-only multi-agent fanout can run concurrently inside one runtime. The controller
        // still leases write-capable jobs one at a time, so this default does not let one runtime
        // hoard sibling edits that should be distributed across runtimes or coordinated manually.
        .unwrap_or(5)
        .clamp(1, 5);

    if strict_mode {
        lease_max_jobs.min(1)
    } else {
        lease_max_jobs
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub controller_base_url: reqwest::Url,
    pub controller_jwks_url: reqwest::Url,
    pub project_id: Uuid,
    pub runtime_id: Option<Uuid>,
    pub runtime_lease_id: Option<Uuid>,
    pub provider: String,
    pub runtime_version: String,
    pub capabilities: Value,
    pub metadata: Value,
    pub lease_scope: Option<String>,
    pub workspace_manifest: Option<Value>,
    pub tenant_projects: Vec<Uuid>,
    pub parent_lease_id: Option<Uuid>,
    pub poll_interval: Duration,
    pub lease_max_jobs: u32,
    pub lease_seconds: u32,
    pub heartbeat_seconds: u32,
    pub workspace_root: PathBuf,
    pub project_workspace_override: Option<PathBuf>,
    pub strict_mode: bool,
    pub dev_isolation_mode: bool,
    pub display_name: Option<String>,
    pub origin: Option<OriginSettings>,
    pub codex_bin: Option<PathBuf>,
    pub require_codex_bin: bool,
    pub runtime_access_token: Option<String>,
    /// Electron owns the desktop process tree and dispositions the controller
    /// runtime only after every descendant has exited.
    pub parent_dispositions_runtime_on_shutdown: bool,
}

#[derive(Clone, Debug)]
pub struct OriginSettings {
    pub origin_id: Uuid,
    pub bind_host: String,
    pub bind_port: u16,
    pub git_remote_url: Option<String>,
    pub git_branch: String,
    pub git_remote_name: String,
    pub git_author_name: String,
    pub git_author_email: String,
    pub rathole_bin: String,
    pub rathole_state_dir: PathBuf,
    pub rathole_use_subcommands: bool,
    pub tunnel_refresh_margin: Duration,
    pub controller_internal_token: Option<String>,
    pub skip_auth: bool,
    pub enable_presence_heartbeat: bool,
    pub presence_interval: Duration,
    pub jwks_url: reqwest::Url,
    pub max_archive_bytes: u64,
    pub staging_root: Option<PathBuf>,
    pub endpoint: Option<String>,
    pub protocols: Vec<String>,
    pub region: Option<String>,
    pub device_id: Option<String>,
    pub metadata: Option<Value>,
    pub mode: String,
    pub tunnel_enabled: bool,
    pub tunnel_provider: Option<String>,
    pub tunnel_hostname: Option<String>,
    pub tunnel_url: Option<String>,
    pub tunnel_id: Option<String>,
    pub tunnel_status: Option<String>,
    pub tunnel_expires_at: Option<DateTime<Utc>>,
    pub tunnel_last_rotation_at: Option<DateTime<Utc>>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let controller_base_url = std::env::var("CONTROLLER_BASE_URL")
            .unwrap_or_else(|_| "http://host.docker.internal:8788".to_string());
        let controller_base_url =
            reqwest::Url::parse(&controller_base_url).context("invalid CONTROLLER_BASE_URL")?;

        let controller_jwks_url = match std::env::var("CONTROLLER_JWKS_URL") {
            Ok(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    controller_base_url
                        .join("/.well-known/jwks.json")
                        .context("failed to derive default controller JWKS URL")?
                } else {
                    reqwest::Url::parse(trimmed).context("invalid CONTROLLER_JWKS_URL")?
                }
            }
            Err(_) => controller_base_url
                .join("/.well-known/jwks.json")
                .context("failed to derive default controller JWKS URL")?,
        };

        let runtime_access_token = std::env::var("RUNTIME_ACCESS_TOKEN")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());
        let parent_dispositions_runtime_on_shutdown =
            parse_env_bool("INSTAFY_RUNTIME_PARENT_DISPOSITION").unwrap_or(false);

        if runtime_access_token.is_none() {
            return Err(anyhow!(
                "RUNTIME_ACCESS_TOKEN must be set to register the runtime"
            ));
        }

        let project_id = std::env::var("SPACE_ID").context("SPACE_ID must be set")?;
        let project_id =
            Uuid::parse_str(project_id.trim()).context("SPACE_ID must be a valid UUID")?;

        let runtime_id = std::env::var("RUNTIME_ID")
            .ok()
            .and_then(|raw| Uuid::parse_str(raw.trim()).ok());

        let runtime_lease_id = std::env::var("RUNTIME_LEASE_ID")
            .ok()
            .and_then(|raw| Uuid::parse_str(raw.trim()).ok());

        let provider = std::env::var("RUNTIME_PROVIDER")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                std::env::var("RUNTIME_TYPE").unwrap_or_else(|_| "self-hosted".to_string())
            });
        let runtime_version =
            std::env::var("RUNTIME_VERSION").unwrap_or_else(|_| "local-runtime".to_string());

        let display_name = std::env::var("RUNTIME_DISPLAY_NAME").ok().and_then(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });

        let mut capabilities = std::env::var("RUNTIME_CAPABILITIES")
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| {
                serde_json::json!({
                    "fs": true,
                    "github": true,
                    "supabase": true,
                    "runs": true,
                    "agent": true,
                    "origin": true,
                    "activeTurnInput": true,
                    "conversations": {
                        "stateful": true,
                        "activeTurnInput": true
                    },
                    "supportsStatefulConversations": true
                })
            });
        if !capabilities.is_object() {
            capabilities = serde_json::json!({});
        }
        // Ensure agent/origin flags are present so the controller can schedule chat + apply work.
        if let Some(map) = capabilities.as_object_mut() {
            map.insert("agent".to_string(), serde_json::json!(true));
            map.insert("origin".to_string(), serde_json::json!(true));
            map.insert("activeTurnInput".to_string(), serde_json::json!(true));
            map.insert(
                "supportsStatefulConversations".to_string(),
                serde_json::json!(true),
            );
            let conversations = map
                .entry("conversations".to_string())
                .or_insert_with(|| serde_json::json!({}));
            if !conversations.is_object() {
                *conversations = serde_json::json!({});
            }
            if let Some(conversation_map) = conversations.as_object_mut() {
                conversation_map.insert("stateful".to_string(), serde_json::json!(true));
                conversation_map.insert("activeTurnInput".to_string(), serde_json::json!(true));
            }
        }

        let metadata = std::env::var("RUNTIME_METADATA")
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| serde_json::json!({}));

        let lease_scope = std::env::var("RUNTIME_LEASE_SCOPE")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());

        let workspace_manifest = std::env::var("RUNTIME_WORKSPACE_MANIFEST")
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());

        let parent_lease_id = std::env::var("RUNTIME_PARENT_LEASE_ID")
            .ok()
            .and_then(|raw| {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Uuid::parse_str(trimmed).ok()
                }
            });

        let tenant_projects: Vec<Uuid> = std::env::var("RUNTIME_TENANT_PROJECTS")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .filter_map(|item| {
                        let trimmed = item.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Uuid::parse_str(trimmed).ok()
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let poll_interval = std::env::var("RUNTIME_POLL_INTERVAL_MS")
            .ok()
            .and_then(|raw| raw.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_millis(2000));

        let strict_mode = parse_env_bool("RUNTIME_STRICT_MODE").unwrap_or(false);
        let dev_isolation_mode = parse_env_bool("RUNTIME_DEV_ISOLATION").unwrap_or(false);
        let lease_max_jobs = normalize_lease_max_jobs(
            std::env::var("RUNTIME_LEASE_MAX_JOBS").ok().as_deref(),
            strict_mode,
        );

        let lease_seconds = std::env::var("RUNTIME_LEASE_SECONDS")
            .ok()
            .and_then(|raw| raw.parse::<u32>().ok())
            .unwrap_or(300);

        let heartbeat_seconds = std::env::var("RUNTIME_HEARTBEAT_SECONDS")
            .ok()
            .and_then(|raw| raw.parse::<u32>().ok())
            .unwrap_or(120);

        let workspace_root = PathBuf::from(
            std::env::var("WORKSPACE_DIR").unwrap_or_else(|_| "/workspace".to_string()),
        );
        fs::create_dir_all(&workspace_root)
            .with_context(|| format!("failed to create workspace root {:?}", workspace_root))?;

        // WORKSPACE_PROJECT_DIR pins this runtime's project to an explicit folder
        // (bring-your-own-folder bindings) instead of <WORKSPACE_DIR>/<projectId>.
        let project_workspace_override = std::env::var("WORKSPACE_PROJECT_DIR")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);

        let default_workspace = match project_workspace_override.as_ref() {
            Some(dir) => dir.clone(),
            None => workspace_root.join(project_id.to_string()),
        };
        fs::create_dir_all(&default_workspace).with_context(|| {
            format!(
                "failed to create default project workspace {:?}",
                default_workspace
            )
        })?;
        let codex_bin = std::env::var("CODEX_BIN").ok().map(PathBuf::from);
        let require_codex_bin = parse_env_bool("RUNTIME_REQUIRE_CODEX_BIN").unwrap_or(false);

        let origin_id_env = std::env::var("ORIGIN_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        // Default to "enabled when ORIGIN_ID is present" so hosted runtimes can omit origin
        // entirely without needing extra env wiring.
        let origin_enabled = parse_env_bool("ORIGIN_ENABLED").unwrap_or(origin_id_env.is_some());

        let origin_settings = if !origin_enabled {
            None
        } else {
            match origin_id_env {
                Some(raw) => {
                    let origin_id =
                        Uuid::parse_str(&raw).context("ORIGIN_ID must be a valid UUID")?;
                    let bind_host =
                        std::env::var("ORIGIN_BIND_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
                    let bind_port = std::env::var("ORIGIN_BIND_PORT")
                        .ok()
                        .and_then(|raw| raw.parse::<u16>().ok())
                        .unwrap_or(54332);
                    let rathole_bin =
                        std::env::var("RATHOLE_BIN").unwrap_or_else(|_| "rathole".to_string());
                    let rathole_state_dir = std::env::var("RATHOLE_STATE_DIR")
                        .map(PathBuf::from)
                        .unwrap_or_else(|_| workspace_root.join(".instafy").join("rathole"));
                    let rathole_use_subcommands = parse_env_bool("RATHOLE_USE_SUBCOMMANDS")
                        .unwrap_or_else(|| detect_rathole_use_subcommands(&rathole_bin));
                    let tunnel_refresh_margin =
                        std::env::var("ORIGIN_TUNNEL_REFRESH_MARGIN_SECONDS")
                            .ok()
                            .and_then(|raw| raw.parse::<u64>().ok())
                            .map(Duration::from_secs)
                            .unwrap_or_else(|| Duration::from_secs(60));
                    let mut controller_internal_token = std::env::var("ORIGIN_INTERNAL_TOKEN")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    if controller_internal_token.is_none() {
                        controller_internal_token = runtime_access_token.clone();
                    }
                    let skip_auth = parse_env_bool("ORIGIN_SKIP_AUTH").unwrap_or(false);
                    let enable_presence_heartbeat =
                        parse_env_bool("ORIGIN_ENABLE_PRESENCE_HEARTBEAT").unwrap_or(true);
                    let presence_interval = std::env::var("ORIGIN_PRESENCE_INTERVAL_MS")
                        .ok()
                        .and_then(|raw| raw.parse::<u64>().ok())
                        .map(Duration::from_millis)
                        .unwrap_or_else(|| Duration::from_millis(20_000));
                    let max_archive_bytes = std::env::var("ORIGIN_MAX_ARCHIVE_BYTES")
                        .ok()
                        .and_then(|raw| raw.parse::<u64>().ok())
                        .unwrap_or(1024 * 1024 * 1024);
                    let staging_root = std::env::var("ORIGIN_STAGING_ROOT").ok().map(PathBuf::from);
                    let git_remote_url = std::env::var("ORIGIN_GIT_REMOTE_URL")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    let git_branch = std::env::var("ORIGIN_GIT_BRANCH")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| "main".to_string());
                    let git_remote_name = std::env::var("ORIGIN_GIT_REMOTE_NAME")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| "origin".to_string());
                    let git_author_name = std::env::var("ORIGIN_GIT_AUTHOR_NAME")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| "instafy-origin".to_string());
                    let git_author_email = std::env::var("ORIGIN_GIT_AUTHOR_EMAIL")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| "origin@instafy.dev".to_string());
                    let endpoint = std::env::var("ORIGIN_ENDPOINT")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    let protocols = std::env::var("ORIGIN_PROTOCOLS")
                        .ok()
                        .map(|raw| {
                            raw.split(',')
                                .map(|item| item.trim().to_ascii_lowercase())
                                .filter(|value| !value.is_empty())
                                .collect::<Vec<String>>()
                        })
                        .filter(|list: &Vec<String>| !list.is_empty())
                        .unwrap_or_else(|| vec!["http".to_string()]);
                    let region = std::env::var("ORIGIN_REGION")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    let device_id = std::env::var("ORIGIN_DEVICE_ID")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    let metadata = std::env::var("ORIGIN_METADATA")
                        .ok()
                        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
                    let mode = std::env::var("ORIGIN_MODE")
                        .unwrap_or_else(|_| "desktop".to_string())
                        .trim()
                        .to_ascii_lowercase();
                    let tunnel_enabled = parse_env_bool("ORIGIN_TUNNEL_ENABLED")
                        .unwrap_or_else(|| mode != "desktop");
                    let tunnel_provider = std::env::var("ORIGIN_TUNNEL_PROVIDER")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    let tunnel_hostname = std::env::var("ORIGIN_TUNNEL_HOSTNAME")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    let tunnel_url = std::env::var("ORIGIN_TUNNEL_URL")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());
                    let tunnel_id = std::env::var("ORIGIN_TUNNEL_ID")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty());

                    let jwks_url = match std::env::var("ORIGIN_JWKS_URL")
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                    {
                        Some(explicit) => {
                            reqwest::Url::parse(&explicit).context("invalid ORIGIN_JWKS_URL")?
                        }
                        None => controller_base_url
                            .join("/.well-known/jwks.json")
                            .context("failed to derive default origin JWKS URL")?,
                    };

                    Some(OriginSettings {
                        origin_id,
                        bind_host,
                        bind_port,
                        git_remote_url,
                        git_branch,
                        git_remote_name,
                        git_author_name,
                        git_author_email,
                        rathole_bin,
                        rathole_state_dir,
                        rathole_use_subcommands,
                        tunnel_refresh_margin,
                        controller_internal_token,
                        skip_auth,
                        enable_presence_heartbeat,
                        presence_interval,
                        jwks_url,
                        max_archive_bytes,
                        staging_root,
                        endpoint,
                        protocols,
                        region,
                        device_id,
                        metadata,
                        mode,
                        tunnel_enabled,
                        tunnel_provider,
                        tunnel_hostname,
                        tunnel_url,
                        tunnel_id,
                        tunnel_status: None,
                        tunnel_expires_at: None,
                        tunnel_last_rotation_at: None,
                    })
                }
                None => {
                    return Err(anyhow!(
                        "ORIGIN_ID must be set when launching a runtime origin"
                    ));
                }
            }
        };

        Ok(Self {
            controller_base_url,
            controller_jwks_url,
            project_id,
            runtime_id,
            runtime_lease_id,
            provider,
            runtime_version,
            capabilities,
            metadata,
            lease_scope,
            workspace_manifest,
            tenant_projects,
            parent_lease_id,
            poll_interval,
            lease_max_jobs,
            lease_seconds,
            heartbeat_seconds,
            workspace_root,
            project_workspace_override,
            strict_mode,
            dev_isolation_mode,
            display_name,
            origin: origin_settings,
            codex_bin,
            require_codex_bin,
            runtime_access_token,
            parent_dispositions_runtime_on_shutdown,
        })
    }

    /// Resolve the on-disk workspace folder for a project. The runtime's own
    /// project honors `WORKSPACE_PROJECT_DIR` when set; everything else uses
    /// `<WORKSPACE_DIR>/<projectId>`.
    pub fn project_workspace_dir(&self, project_id: &Uuid) -> PathBuf {
        if *project_id == self.project_id {
            if let Some(dir) = self.project_workspace_override.as_ref() {
                return dir.clone();
            }
        }
        self.workspace_root.join(project_id.to_string())
    }
}

fn detect_rathole_use_subcommands(bin: &str) -> bool {
    let Ok(output) = Command::new(bin).arg("--help").output() else {
        return false;
    };
    let mut help = String::new();
    help.push_str(&String::from_utf8_lossy(&output.stdout));
    help.push_str(&String::from_utf8_lossy(&output.stderr));
    let lower = help.to_ascii_lowercase();
    if lower.contains("usage: rathole <config") || lower.contains("usage: rathole <path") {
        return false;
    }
    if lower.contains("commands:") || lower.contains("subcommands") || lower.contains("<command>") {
        return lower.contains("client") && lower.contains("server");
    }
    false
}

#[cfg(test)]
mod tests {
    use super::normalize_lease_max_jobs;

    #[test]
    fn lease_max_jobs_defaults_to_read_only_batch_capacity() {
        assert_eq!(normalize_lease_max_jobs(None, false), 5);
    }

    #[test]
    fn lease_max_jobs_honors_explicit_bounded_override() {
        assert_eq!(normalize_lease_max_jobs(Some("3"), false), 3);
        assert_eq!(normalize_lease_max_jobs(Some("12"), false), 5);
        assert_eq!(normalize_lease_max_jobs(Some("0"), false), 1);
    }

    #[test]
    fn lease_max_jobs_strict_mode_forces_single_job_leases() {
        assert_eq!(normalize_lease_max_jobs(Some("3"), true), 1);
    }
}
