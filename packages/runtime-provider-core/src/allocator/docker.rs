use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::Url;
use serde_json::Value as JsonValue;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::task;
use tracing::{info, warn};
use uuid::Uuid;

use super::{
    canonical_managed_runtime_env_value, is_allowed_managed_runtime_env_key,
    is_exact_managed_provider, managed_webdev_generation_matches, runtime_metadata_for_process,
    EnsureRuntimeOutcome, EnsureRuntimeRequest, RuntimeAllocator, MANAGED_RUNTIME_FLAVOR_KEY,
    MANAGED_RUNTIME_LAUNCH_ATTESTATION, MANAGED_RUNTIME_WEBDEV_FLAVOR,
};
use crate::config::ProviderConfig;

const DOCKER_COMMAND_OUTPUT_LIMIT: usize = 8_000;

pub struct DockerRuntimeAllocator {
    compose_file: PathBuf,
    compose_dir: PathBuf,
    service_name: String,
    project_prefix: String,
    controller_base_url: Option<String>,
    repo_base: Option<PathBuf>,
    codex_base: PathBuf,
    runtime_agent_image: Option<String>,
    runtime_agent_webdev_image: Option<String>,
    compose_semaphore: Arc<Semaphore>,
    assigned_ports: Mutex<HashMap<Uuid, u16>>,
    runtime_operation_locks: Mutex<HashMap<Uuid, Arc<Mutex<()>>>>,
    built_images: Mutex<HashSet<String>>,
}

impl DockerRuntimeAllocator {
    pub(crate) fn new(config: &ProviderConfig) -> anyhow::Result<Self> {
        let compose_file = config
            .runtime_docker_compose_file
            .clone()
            .unwrap_or_else(super::default_compose_file);
        let compose_file = resolve_path_search(&compose_file, true)?;
        let compose_dir = compose_file
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| anyhow::anyhow!("compose file has no parent directory"))?;

        let repo_base = config
            .runtime_docker_repo_host
            .clone()
            .map(|path| resolve_path_search(&path, false))
            .transpose()?;

        let codex_base = match config.runtime_docker_codex_root.clone() {
            Some(path) => resolve_path_search(&path, false)?,
            None => std::env::temp_dir().join("instafy-runtime-codex"),
        };
        std::fs::create_dir_all(&codex_base).ok();

        let max_ops = config.runtime_docker_max_concurrent_ops.max(1);
        let controller_base_url = std::env::var("CONTROLLER_BASE_URL")
            .ok()
            .or_else(|| std::env::var("PROXY_CONTROLLER_BASE_URL").ok())
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());
        Ok(Self {
            compose_file,
            compose_dir,
            service_name: config.runtime_docker_service.clone(),
            project_prefix: config.runtime_docker_project_prefix.clone(),
            controller_base_url,
            repo_base,
            codex_base,
            runtime_agent_image: config
                .runtime_agent_image
                .as_deref()
                .and_then(normalize_runtime_agent_image),
            runtime_agent_webdev_image: config
                .runtime_agent_webdev_image
                .as_deref()
                .and_then(normalize_runtime_agent_image),
            compose_semaphore: Arc::new(Semaphore::new(max_ops)),
            assigned_ports: Mutex::new(HashMap::new()),
            runtime_operation_locks: Mutex::new(HashMap::new()),
            built_images: Mutex::new(HashSet::new()),
        })
    }

    async fn acquire_compose_permit(&self) -> anyhow::Result<OwnedSemaphorePermit> {
        self.compose_semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| anyhow::anyhow!("failed to acquire docker compose semaphore: {error}"))
    }

    fn sanitize_project_name(&self, project_id: Uuid, runtime_id: Uuid) -> String {
        // Include the runtime id to allow multiple runtime containers per project.
        let short_suffix = runtime_id.to_string().chars().take(8).collect::<String>();
        format!(
            "{}{}-{}",
            self.project_prefix,
            project_id.simple(),
            short_suffix
        )
    }

    async fn get_or_allocate_port(&self, runtime_id: Uuid) -> anyhow::Result<u16> {
        let mut guard = self.assigned_ports.lock().await;
        if let Some(port) = guard.get(&runtime_id) {
            return Ok(*port);
        }
        for _ in 0..32 {
            // Bind to all interfaces since Docker publishes runtime ports on 0.0.0.0.
            // This still has a TOCTOU window between allocating the port and Docker binding it,
            // so callers should handle collisions by retrying with a fresh port.
            let listener = TcpListener::bind(("0.0.0.0", 0))?;
            let port = listener.local_addr()?.port();
            drop(listener);
            if !guard.values().any(|existing| *existing == port) {
                guard.insert(runtime_id, port);
                return Ok(port);
            }
        }
        Err(anyhow::anyhow!("unable to allocate free host port"))
    }

    async fn runtime_operation_lock(&self, runtime_id: Uuid) -> Arc<Mutex<()>> {
        let mut guard = self.runtime_operation_locks.lock().await;
        guard
            .entry(runtime_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn finalize_runtime_stop(
        &self,
        runtime_id: Uuid,
        compose_down_result: anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        // Always forget the local port assignment. A failed compose down must
        // still be returned to the provider service/controller so strict
        // callers can retry the idempotent release instead of receiving a
        // false acknowledgement while containers remain alive.
        let mut guard = self.assigned_ports.lock().await;
        guard.remove(&runtime_id);
        compose_down_result
    }

    async fn stop_runtime_generation(
        &self,
        project_id: Uuid,
        runtime_id: Uuid,
        expected_lease_id: Option<Uuid>,
    ) -> anyhow::Result<()> {
        let runtime_lock = self.runtime_operation_lock(runtime_id).await;
        let _operation_guard = runtime_lock.lock().await;
        let project_name = self.sanitize_project_name(project_id, runtime_id);

        if let Some(expected_lease_id) = expected_lease_id {
            let container_ids = self.service_container_ids(&project_name).await?;
            for container_id in &container_ids {
                let observed_lease_id = self.container_lease_id(container_id).await?;
                match observed_lease_id {
                    Some(observed_lease_id) if observed_lease_id == expected_lease_id => {}
                    Some(observed_lease_id) => {
                        anyhow::bail!(
                            "runtime lease generation mismatch for container {container_id}: expected {expected_lease_id}, observed {observed_lease_id}"
                        );
                    }
                    None => {
                        anyhow::bail!(
                            "cannot prove runtime lease generation for container {container_id}"
                        );
                    }
                }
            }
        }

        let compose_down_result = self.run_compose_down(&project_name).await;
        if let Err(error) = &compose_down_result {
            warn!(
                %project_id,
                %runtime_id,
                %project_name,
                %error,
                "docker runtime allocator failed to compose down"
            );
        }
        self.finalize_runtime_stop(runtime_id, compose_down_result)
            .await
    }

    async fn running_service_container_ids(
        &self,
        project_name: &str,
    ) -> anyhow::Result<Vec<String>> {
        let compose_file = self.compose_file.clone();
        let compose_dir = self.compose_dir.clone();
        let service = self.service_name.clone();
        let project_name = project_name.to_string();
        let permit = self.acquire_compose_permit().await?;
        let output = task::spawn_blocking(move || {
            let _permit = permit;
            Command::new("docker")
                .current_dir(compose_dir)
                .env("COMPOSE_PROJECT_NAME", &project_name)
                .arg("compose")
                .arg("-p")
                .arg(&project_name)
                .arg("-f")
                .arg(&compose_file)
                .arg("ps")
                .arg("-q")
                .arg("--status")
                .arg("running")
                .arg(&service)
                .output()
        })
        .await??;

        if !output.status.success() {
            anyhow::bail!(
                "docker compose ps failed while resolving runtime containers: {}",
                summarize_command_output(&output)
            );
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect())
    }

    async fn service_container_ids(&self, project_name: &str) -> anyhow::Result<Vec<String>> {
        let compose_file = self.compose_file.clone();
        let compose_dir = self.compose_dir.clone();
        let service = self.service_name.clone();
        let project_name = project_name.to_string();
        let permit = self.acquire_compose_permit().await?;
        let output = task::spawn_blocking(move || {
            let _permit = permit;
            Command::new("docker")
                .current_dir(compose_dir)
                .env("COMPOSE_PROJECT_NAME", &project_name)
                .arg("compose")
                .arg("-p")
                .arg(&project_name)
                .arg("-f")
                .arg(&compose_file)
                .arg("ps")
                .arg("-a")
                .arg("-q")
                .arg(&service)
                .output()
        })
        .await??;

        if !output.status.success() {
            anyhow::bail!(
                "docker compose ps failed while resolving runtime containers: {}",
                summarize_command_output(&output)
            );
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect())
    }

    async fn container_lease_id(&self, container_id: &str) -> anyhow::Result<Option<Uuid>> {
        async fn read_env(container_id: &str, key: &str) -> anyhow::Result<Option<String>> {
            let container_id = container_id.to_string();
            let prefix = format!("{key}=");
            let output = task::spawn_blocking(move || {
                Command::new("docker")
                    .arg("inspect")
                    .arg("--format")
                    .arg("{{range .Config.Env}}{{println .}}{{end}}")
                    .arg(&container_id)
                    .output()
            })
            .await??;

            if !output.status.success() {
                anyhow::bail!(
                    "docker inspect failed while resolving runtime lease: {}",
                    summarize_command_output(&output)
                );
            }

            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let trimmed = line.trim();
                if let Some(value) = trimmed.strip_prefix(&prefix) {
                    let value = value.trim();
                    if value.is_empty() {
                        return Ok(None);
                    }
                    return Ok(Some(value.to_string()));
                }
            }

            Ok(None)
        }

        for key in ["RUNTIME_LEASE_ID", "ORIGIN_LEASE_ID"] {
            if let Some(value) = read_env(container_id, key).await? {
                if let Ok(id) = Uuid::parse_str(value.trim()) {
                    return Ok(Some(id));
                }
            }
        }
        Ok(None)
    }

    async fn run_compose_up_with_flags(
        &self,
        project_name: &str,
        envs: &[(String, String)],
        force_recreate: bool,
    ) -> anyhow::Result<()> {
        let compose_file = self.compose_file.clone();
        let compose_dir = self.compose_dir.clone();
        let service = self.service_name.clone();
        let project_prefix = self.project_prefix.clone();
        let project_name = project_name.to_string();
        let envs = envs.to_vec();
        let force_recreate_flag = force_recreate;
        let build_target = envs
            .iter()
            .find(|(key, _)| key == "RUNTIME_AGENT_BUILD_TARGET")
            .map(|(_, value)| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let build_requested = build_target.is_some();
        let runtime_image = envs
            .iter()
            .find(|(key, _)| key == "RUNTIME_AGENT_IMAGE")
            .map(|(_, value)| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let runtime_image_name = runtime_image
            .as_deref()
            .unwrap_or("runtime-agent:local")
            .trim()
            .to_string();
        let force_build = envs
            .iter()
            .find(|(key, _)| key == "RUNTIME_AGENT_FORCE_BUILD")
            .map(|(_, value)| value.trim().to_ascii_lowercase())
            .map(|value| value == "1" || value == "true" || value == "yes")
            .unwrap_or(false);
        let build_key = build_target
            .as_deref()
            .map(|target| format!("{}|{}", runtime_image_name, target));
        let build_cached = if let Some(key) = build_key.as_deref() {
            let guard = self.built_images.lock().await;
            guard.contains(key)
        } else {
            false
        };
        let permit = self.acquire_compose_permit().await?;
        task::spawn_blocking(move || -> anyhow::Result<()> {
            let _permit = permit;
            let cleanup_project_artifacts = |project_name: &str, service: &str| {
                let _ = Command::new("docker")
                    .current_dir(&compose_dir)
                    .env("COMPOSE_PROJECT_NAME", project_name)
                    .arg("compose")
                    .arg("-p")
                    .arg(project_name)
                    .arg("-f")
                    .arg(&compose_file)
                    .arg("down")
                    .arg("--remove-orphans")
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .status();

                let proxy_container = format!("{project_name}-proxy-1");
                let runtime_container = format!("{project_name}-{service}-1");
                let _ = Command::new("docker")
                    .arg("rm")
                    .arg("-f")
                    .arg(&proxy_container)
                    .arg(&runtime_container)
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .status();

                let _ = Command::new("docker")
                    .arg("network")
                    .arg("rm")
                    .arg(format!("{project_name}_default"))
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .status();
            };

            let cleanup_global_runtime_artifacts =
                |project_prefix: &str| -> anyhow::Result<(usize, usize)> {
                    let container_output = Command::new("docker")
                        .arg("ps")
                        .arg("-a")
                        .arg("--format")
                        .arg("{{.ID}}\t{{.Names}}\t{{.Status}}")
                        .arg("--filter")
                        .arg(format!("name={project_prefix}"))
                        .output()?;
                    let stale_container_ids = if container_output.status.success() {
                        parse_stale_runtime_container_ids(
                            &String::from_utf8_lossy(&container_output.stdout),
                            project_prefix,
                        )
                    } else {
                        Vec::new()
                    };
                    let stale_container_count = stale_container_ids.len();
                    if !stale_container_ids.is_empty() {
                        let _ = Command::new("docker")
                            .arg("rm")
                            .arg("-f")
                            .args(&stale_container_ids)
                            .stdout(Stdio::inherit())
                            .stderr(Stdio::inherit())
                            .status();
                    }

                    let network_output = Command::new("docker")
                        .arg("network")
                        .arg("ls")
                        .arg("--format")
                        .arg("{{.ID}}\t{{.Name}}")
                        .arg("--filter")
                        .arg(format!("name={project_prefix}"))
                        .output()?;
                    let stale_network_ids = if network_output.status.success() {
                        parse_prefixed_resource_ids(
                            &String::from_utf8_lossy(&network_output.stdout),
                            project_prefix,
                        )
                    } else {
                        Vec::new()
                    };
                    let stale_network_count = stale_network_ids.len();
                    if !stale_network_ids.is_empty() {
                        let _ = Command::new("docker")
                            .arg("network")
                            .arg("rm")
                            .args(&stale_network_ids)
                            .stdout(Stdio::inherit())
                            .stderr(Stdio::inherit())
                            .status();
                    }

                    Ok((stale_container_count, stale_network_count))
                };

            if !build_requested && image_ref_looks_remote(&runtime_image_name) {
                let pull_output = Command::new("docker")
                    .arg("pull")
                    .arg(&runtime_image_name)
                    .output()?;
                if !pull_output.status.success() {
                    return Err(anyhow::anyhow!(
                        "docker pull failed for runtime image {}: {}",
                        runtime_image_name,
                        summarize_command_output(&pull_output)
                    ));
                }
            }

            let should_build = if !build_requested {
                false
            } else if force_build {
                true
            } else if build_cached {
                false
            } else {
                let inspect = Command::new("docker")
                    .arg("image")
                    .arg("inspect")
                    .arg(&runtime_image_name)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                match inspect {
                    Ok(status) => !status.success(),
                    Err(_) => true,
                }
            };

            let mut build_cmd = Command::new("docker");
            build_cmd
                .current_dir(&compose_dir)
                .env("COMPOSE_PROJECT_NAME", &project_name)
                .arg("compose")
                .arg("-p")
                .arg(&project_name)
                .arg("-f")
                .arg(&compose_file)
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());

            if should_build {
                let mut build = build_cmd;
                build.arg("build").arg(&service);
                for (key, value) in &envs {
                    build.env(key, value);
                }
                let output = build.output()?;
                if !output.status.success() {
                    return Err(anyhow::anyhow!(
                        "docker compose build failed: {}",
                        summarize_command_output(&output)
                    ));
                }
            }

            let mut up = Command::new("docker");
            up.current_dir(&compose_dir)
                .env("COMPOSE_PROJECT_NAME", &project_name)
                .arg("compose")
                .arg("-p")
                .arg(&project_name)
                .arg("-f")
                .arg(&compose_file)
                .arg("up")
                .arg("--no-build")
                .args(force_recreate_flag.then_some("--force-recreate"))
                .arg("-d")
                .arg(&service);
            for (key, value) in &envs {
                up.env(key, value);
            }
            let first_output = up.output()?;
            if first_output.status.success() {
                return Ok(());
            }

            warn!(
                project_name = %project_name,
                service = %service,
                output = %summarize_command_output(&first_output),
                "docker compose up failed; attempting cleanup + retry"
            );

            cleanup_project_artifacts(&project_name, &service);

            match cleanup_global_runtime_artifacts(&project_prefix) {
                Ok((stale_container_count, stale_network_count))
                    if stale_container_count > 0 || stale_network_count > 0 =>
                {
                    warn!(
                        project_prefix = %project_prefix,
                        stale_container_count,
                        stale_network_count,
                        "docker runtime allocator cleaned stale runtime artifacts before retry"
                    );
                }
                Ok(_) => {}
                Err(error) => {
                    warn!(
                        project_prefix = %project_prefix,
                        %error,
                        "docker runtime allocator failed to cleanup stale runtime artifacts"
                    );
                }
            }

            let mut retry = Command::new("docker");
            retry
                .current_dir(&compose_dir)
                .env("COMPOSE_PROJECT_NAME", &project_name)
                .arg("compose")
                .arg("-p")
                .arg(&project_name)
                .arg("-f")
                .arg(&compose_file)
                .arg("up")
                .arg("--no-build")
                .args(force_recreate_flag.then_some("--force-recreate"))
                .arg("-d")
                .arg(&service);
            for (key, value) in &envs {
                retry.env(key, value);
            }
            let retry_output = retry.output()?;
            if retry_output.status.success() {
                return Ok(());
            }

            warn!(
                project_name = %project_name,
                service = %service,
                output = %summarize_command_output(&retry_output),
                "docker compose up failed after cleanup retry; attempting final cleanup"
            );

            cleanup_project_artifacts(&project_name, &service);

            Err(anyhow::anyhow!(
                "docker compose up failed after cleanup retry. first_attempt=({}) retry=({})",
                summarize_command_output(&first_output),
                summarize_command_output(&retry_output)
            ))
        })
        .await??;
        if build_requested {
            if let Some(key) = build_key {
                let mut guard = self.built_images.lock().await;
                guard.insert(key);
            }
        }
        Ok(())
    }

    async fn run_compose_down(&self, project_name: &str) -> anyhow::Result<()> {
        let compose_file = self.compose_file.clone();
        let compose_dir = self.compose_dir.clone();
        let project_name = project_name.to_string();
        let permit = self.acquire_compose_permit().await?;
        let status = task::spawn_blocking(move || {
            let _permit = permit;
            Command::new("docker")
                .current_dir(compose_dir)
                .env("COMPOSE_PROJECT_NAME", &project_name)
                .arg("compose")
                .arg("-p")
                .arg(&project_name)
                .arg("-f")
                .arg(&compose_file)
                .arg("down")
                .arg("--remove-orphans")
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .status()
        })
        .await??;
        anyhow::ensure!(status.success(), "docker compose down failed");
        Ok(())
    }

    fn build_env(
        &self,
        request: &EnsureRuntimeRequest,
        host_port: u16,
    ) -> anyhow::Result<Vec<(String, String)>> {
        let mut envs = Vec::new();
        let project_id = request.project_id.to_string();
        envs.push(("SPACE_ID".to_string(), project_id.clone()));
        // The local webdev runtime image may still read PROJECT_ID while SPACE_ID rolls out.
        // Keep them mirrored so hosted runtimes register against the active space reliably.
        envs.push(("PROJECT_ID".to_string(), project_id.clone()));
        envs.push(("RUNTIME_ID".to_string(), request.runtime_id.to_string()));
        envs.push(("RUNTIME_LEASE_ID".to_string(), request.lease_id.to_string()));
        envs.push(("RUNTIME_PROVIDER".to_string(), request.provider.to_string()));
        envs.push(("RUNTIME_TYPE".to_string(), request.provider.to_string()));
        envs.push((
            "RUNTIME_ACCESS_TOKEN".to_string(),
            request.runtime_token.clone(),
        ));
        envs.push(("ORIGIN_HOST_PORT".to_string(), host_port.to_string()));
        envs.push(("ORIGIN_BIND_HOST".to_string(), "0.0.0.0".to_string()));
        envs.push(("ORIGIN_BIND_PORT".to_string(), "54332".to_string()));
        // The runtime compose stack includes a Codex proxy container. We only need it
        // reachable from within the compose network, so bind it to an ephemeral host
        // port to avoid collisions with the shared proxy service (and other runtimes).
        envs.push(("PROXY_PORT".to_string(), "0".to_string()));
        // Keep the origin token env for bundled origin server compatibility; value matches runtime token.
        envs.push((
            "ORIGIN_INTERNAL_TOKEN".to_string(),
            request.runtime_token.clone(),
        ));
        // Docker-hosted runtimes expose the origin HTTP server via an ephemeral host port already.
        // Disable tunnels to avoid local tunnel-broker flakiness (and reduce moving parts) unless a
        // different allocator explicitly opts in.
        envs.push(("ORIGIN_TUNNEL_ENABLED".to_string(), "0".to_string()));
        if let Some(mode) = request.origin_mode.as_deref() {
            if !mode.is_empty() {
                envs.push(("ORIGIN_MODE".to_string(), mode.to_string()));
            }
        }

        let endpoint = self
            .controller_base_url
            .as_ref()
            .and_then(|base| Url::parse(base).ok())
            .map(|controller_url| {
                let scheme = controller_url.scheme().to_string();
                let host = controller_url
                    .host_str()
                    .map(str::to_string)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "127.0.0.1".to_string());
                format!("{scheme}://{host}:{host_port}")
            })
            .unwrap_or_else(|| format!("http://host.docker.internal:{host_port}"));

        envs.push(("ORIGIN_ENDPOINT".to_string(), endpoint));

        if let Some(url) = &self.controller_base_url {
            envs.push(("CONTROLLER_BASE_URL".to_string(), url.clone()));
        }
        let managed_webdev_image = self.managed_webdev_image(request)?;
        let exact_managed_provider = is_exact_managed_provider(&request.provider);
        let process_metadata =
            runtime_metadata_for_process(&request.provider, request.metadata.as_ref());
        if let Some(meta) = process_metadata.as_ref() {
            envs.push(("RUNTIME_METADATA".to_string(), meta.to_string()));
            if let Some(runtime_image) = managed_webdev_image.clone().or_else(|| {
                (!exact_managed_provider)
                    .then(|| resolve_runtime_agent_image(meta))
                    .flatten()
            }) {
                envs.push(("RUNTIME_AGENT_IMAGE".to_string(), runtime_image));
            }
            if let Some(env_overrides) = meta.get("env").and_then(|value| value.as_object()) {
                for (key, value) in env_overrides {
                    if key == "SPACE_ID" || key == "PROJECT_ID" {
                        continue;
                    }
                    if exact_managed_provider
                        && (!is_allowed_managed_runtime_env_key(key)
                            || canonical_managed_runtime_env_value(value).is_none())
                    {
                        continue;
                    }
                    let rendered = match value {
                        JsonValue::String(s) => s.clone(),
                        JsonValue::Number(n) => n.to_string(),
                        JsonValue::Bool(b) => {
                            if *b {
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
                    envs.push((key.to_string(), rendered));
                }
            }
        }
        if !envs.iter().any(|(key, _)| key == "RUNTIME_AGENT_IMAGE") {
            if let Some(runtime_image) = self.runtime_agent_image.clone() {
                envs.push(("RUNTIME_AGENT_IMAGE".to_string(), runtime_image));
            }
        }

        let has_repo_host = envs.iter().any(|(k, _)| k == "RUNTIME_REPO_HOST");
        if !has_repo_host {
            if let Some(repo_base) = &self.repo_base {
                let project_repo = repo_base.join(request.project_id.to_string());
                std::fs::create_dir_all(&project_repo)?;
                envs.push((
                    "RUNTIME_REPO_HOST".to_string(),
                    project_repo.to_string_lossy().to_string(),
                ));
            }
        }

        let codex_dir = self.codex_base.join(request.project_id.to_string());
        std::fs::create_dir_all(&codex_dir)?;
        envs.push((
            "RUNTIME_CODEX_VOLUME".to_string(),
            codex_dir.to_string_lossy().to_string(),
        ));

        // Per-project toolchain/package cache that survives container
        // recreation (idle stop, re-provision). Without it every wake
        // re-downloads cargo registries, npm/pip caches, and any toolchain
        // the agent installed — the container's writable layer is throwaway.
        if !envs.iter().any(|(key, _)| key == "RUNTIME_CACHE_HOST") {
            let cache_dir = self
                .codex_base
                .parent()
                .map(|base| base.join("workspace-caches"))
                .unwrap_or_else(|| self.codex_base.join("workspace-caches"))
                .join(request.project_id.to_string());
            std::fs::create_dir_all(&cache_dir)?;
            // Freshness stamp: a project resumed after a long pause must not
            // race the TTL cleanup sweep, which decides staleness by file
            // mtimes — touching this file makes the cache instantly fresh.
            let _ = std::fs::write(cache_dir.join(".instafy-ensure-stamp"), b"");
            envs.push((
                "RUNTIME_CACHE_HOST".to_string(),
                cache_dir.to_string_lossy().to_string(),
            ));
        }

        let origin_id = request
            .origin_instance_id
            .ok_or_else(|| anyhow::anyhow!("origin instance id missing for docker allocator"))?;
        envs.push(("ORIGIN_ID".to_string(), origin_id.to_string()));
        envs.push(("ORIGIN_LEASE_ID".to_string(), request.lease_id.to_string()));
        if !request.origin_protocols.is_empty() {
            envs.push((
                "ORIGIN_PROTOCOLS".to_string(),
                request.origin_protocols.join(","),
            ));
        }
        if let Some(origin_meta) = request.origin_metadata.as_ref() {
            envs.push(("ORIGIN_METADATA".to_string(), origin_meta.to_string()));
        }

        Ok(envs)
    }

    fn managed_webdev_image(
        &self,
        request: &EnsureRuntimeRequest,
    ) -> anyhow::Result<Option<String>> {
        if !is_exact_managed_provider(&request.provider) {
            return Ok(None);
        }
        let metadata = request.metadata.as_ref();
        let flavor = metadata
            .and_then(JsonValue::as_object)
            .and_then(|root| root.get(MANAGED_RUNTIME_FLAVOR_KEY))
            .and_then(JsonValue::as_str);
        let has_attestation = metadata
            .and_then(JsonValue::as_object)
            .is_some_and(|root| root.contains_key(MANAGED_RUNTIME_LAUNCH_ATTESTATION));

        match flavor {
            None if !has_attestation => Ok(None),
            Some(MANAGED_RUNTIME_WEBDEV_FLAVOR)
                if managed_webdev_generation_matches(metadata, request.lease_id) =>
            {
                self.runtime_agent_webdev_image
                    .clone()
                    .map(Some)
                    .ok_or_else(|| {
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
}

fn image_ref_looks_remote(image_ref: &str) -> bool {
    let Some((registry, _)) = image_ref.split_once('/') else {
        return false;
    };
    registry.contains('.') || registry.contains(':') || registry == "localhost"
}

fn parse_prefixed_resource_ids(raw: &str, prefix: &str) -> Vec<String> {
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let (id, name) = trimmed.split_once('\t')?;
            let id = id.trim();
            let name = name.trim();
            if id.is_empty() || !name.starts_with(prefix) {
                return None;
            }
            Some(id.to_string())
        })
        .collect()
}

fn parse_stale_runtime_container_ids(raw: &str, prefix: &str) -> Vec<String> {
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let mut parts = trimmed.splitn(3, '\t');
            let id = parts.next()?.trim();
            let name = parts.next()?.trim();
            let status = parts.next()?.trim();
            if id.is_empty()
                || !is_generated_runtime_container_name(name, prefix)
                || !should_cleanup_runtime_container_status(status)
            {
                return None;
            }
            Some(id.to_string())
        })
        .collect()
}

fn is_generated_runtime_container_name(name: &str, prefix: &str) -> bool {
    name.starts_with(prefix) && (name.ends_with("-runtime-1") || name.ends_with("-proxy-1"))
}

fn should_cleanup_runtime_container_status(status: &str) -> bool {
    let normalized = status.trim().to_lowercase();
    if !normalized.starts_with("up ") {
        return true;
    }

    is_old_running_runtime_status(&normalized)
}

fn is_old_running_runtime_status(normalized_status: &str) -> bool {
    if normalized_status.contains("month")
        || normalized_status.contains("week")
        || normalized_status.contains("day")
        || normalized_status.contains("year")
    {
        return true;
    }

    if !normalized_status.contains("hour") {
        return false;
    }

    first_status_quantity(normalized_status)
        .map(|hours| hours >= 24)
        .unwrap_or(false)
}

fn first_status_quantity(status: &str) -> Option<u64> {
    status
        .split(|character: char| !character.is_ascii_digit())
        .find_map(|part| {
            if part.is_empty() {
                None
            } else {
                part.parse::<u64>().ok()
            }
        })
}

fn resolve_runtime_agent_image(metadata: &JsonValue) -> Option<String> {
    metadata
        .as_object()
        .and_then(|meta| {
            meta.get("runtimeAgentImage")
                .or_else(|| meta.get("runtime_agent_image"))
                .and_then(JsonValue::as_str)
        })
        .and_then(normalize_runtime_agent_image)
}

fn normalize_runtime_agent_image(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 512 {
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

fn summarize_command_output(output: &Output) -> String {
    let code = output
        .status
        .code()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "signal".to_string());
    let stderr = clip_command_output(&String::from_utf8_lossy(&output.stderr));
    let stdout = clip_command_output(&String::from_utf8_lossy(&output.stdout));

    match (stderr.is_empty(), stdout.is_empty()) {
        (false, false) => format!("exit={code} stderr={stderr:?} stdout={stdout:?}"),
        (false, true) => format!("exit={code} stderr={stderr:?}"),
        (true, false) => format!("exit={code} stdout={stdout:?}"),
        (true, true) => format!("exit={code}"),
    }
}

fn clip_command_output(raw: &str) -> String {
    let normalized = raw
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if normalized.len() <= DOCKER_COMMAND_OUTPUT_LIMIT {
        return normalized;
    }

    let mut clipped = normalized
        .chars()
        .rev()
        .take(DOCKER_COMMAND_OUTPUT_LIMIT)
        .collect::<Vec<_>>();
    clipped.reverse();
    format!("…{}", clipped.into_iter().collect::<String>())
}

#[async_trait]
impl RuntimeAllocator for DockerRuntimeAllocator {
    async fn ensure_runtime(
        &self,
        request: EnsureRuntimeRequest,
    ) -> anyhow::Result<EnsureRuntimeOutcome> {
        let runtime_lock = self.runtime_operation_lock(request.runtime_id).await;
        let _operation_guard = runtime_lock.lock().await;
        let project_name = self.sanitize_project_name(request.project_id, request.runtime_id);

        let existing_containers = self.service_container_ids(&project_name).await?;
        let running_containers = self.running_service_container_ids(&project_name).await?;
        let mut lease_mismatch = false;
        let mut observed = Vec::new();
        for container_id in &existing_containers {
            match self.container_lease_id(container_id).await {
                Ok(Some(id)) => {
                    observed.push(id);
                    if id != request.lease_id {
                        lease_mismatch = true;
                    }
                }
                Ok(None) => {
                    lease_mismatch = true;
                }
                Err(_) => {
                    lease_mismatch = true;
                }
            }
        }

        if !running_containers.is_empty() && !lease_mismatch {
            return Ok(EnsureRuntimeOutcome {
                launched: false,
                message: Some(format!(
                    "runtime container already running for project {}",
                    request.project_id
                )),
            });
        }

        if lease_mismatch {
            warn!(
                project_id = %request.project_id,
                runtime_id = %request.runtime_id,
                requested_lease_id = %request.lease_id,
                observed_lease_ids = ?observed,
                running_container_count = running_containers.len(),
                existing_container_count = existing_containers.len(),
                "docker runtime allocator found existing container(s) with mismatched lease; recreating"
            );
        }

        let had_existing_containers = !existing_containers.is_empty();
        let mut last_error: Option<anyhow::Error> = None;
        for attempt in 0..5 {
            let port = self.get_or_allocate_port(request.runtime_id).await?;
            let envs = self.build_env(&request, port)?;
            info!(
                project_id = %request.project_id,
                runtime_id = %request.runtime_id,
                lease_id = %request.lease_id,
                provider = %request.provider,
                host_port = port,
                attempt,
                origin_mode = %request.origin_mode.as_deref().unwrap_or_default(),
                origin_protocols = ?request.origin_protocols,
                origin_env_keys = ?envs
                    .iter()
                    .filter(|(key, _)| key.starts_with("ORIGIN_"))
                    .map(|(key, _)| key.as_str())
                    .collect::<Vec<_>>(),
                "docker runtime allocator env prepared"
            );
            info!(
                project_id = %request.project_id,
                runtime_id = %request.runtime_id,
                lease_id = %request.lease_id,
                provider = %request.provider,
                host_port = port,
                attempt,
                "docker runtime allocator invoking compose up"
            );

            // If a previous stop left containers behind (ex: `docker compose down` failed),
            // `docker compose up` may restart a stale container without applying updated env
            // (notably the lease/runtime tokens). Always force-recreate when any container
            // already exists for this compose project to avoid "Starting…" hangs in Studio.
            let force_recreate = had_existing_containers || attempt > 0;
            match self
                .run_compose_up_with_flags(&project_name, &envs, force_recreate)
                .await
            {
                Ok(()) => {
                    info!(
                        project_id = %request.project_id,
                        provider = request.provider,
                        host_port = port,
                        attempt,
                        "docker runtime allocator launched container"
                    );
                    return Ok(EnsureRuntimeOutcome {
                        launched: true,
                        message: Some(format!("launched docker runtime on port {}", port)),
                    });
                }
                Err(error) => {
                    let port_in_use = TcpListener::bind(("0.0.0.0", port)).is_err();
                    warn!(
                        project_id = %request.project_id,
                        runtime_id = %request.runtime_id,
                        lease_id = %request.lease_id,
                        provider = %request.provider,
                        host_port = port,
                        attempt,
                        port_in_use,
                        %error,
                        "docker runtime allocator compose up failed; retrying with a fresh port"
                    );
                    last_error = Some(error);
                    let mut guard = self.assigned_ports.lock().await;
                    guard.remove(&request.runtime_id);
                    // Docker Desktop occasionally reports transient networking errors while rapidly
                    // creating/removing many compose stacks. A small backoff reduces flakiness.
                    tokio::time::sleep(Duration::from_millis(250 * (attempt as u64 + 1))).await;
                    continue;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("docker compose up failed")))
    }

    async fn stop_runtime(&self, project_id: Uuid, runtime_id: Uuid) -> anyhow::Result<()> {
        self.stop_runtime_generation(project_id, runtime_id, None)
            .await
    }

    async fn stop_runtime_if_lease(
        &self,
        project_id: Uuid,
        runtime_id: Uuid,
        lease_id: Option<Uuid>,
    ) -> anyhow::Result<()> {
        self.stop_runtime_generation(project_id, runtime_id, lease_id)
            .await
    }

    async fn runtime_oom_killed(
        &self,
        project_id: Uuid,
        runtime_id: Uuid,
    ) -> anyhow::Result<Option<bool>> {
        let project_name = self.sanitize_project_name(project_id, runtime_id);
        let ids = self.service_container_ids(&project_name).await?;
        let Some(container_id) = ids.first().cloned() else {
            return Ok(None);
        };
        // Docker sets State.OOMKilled from the container cgroup's oom_kill
        // events; on cgroup v2 this also catches child processes (the common
        // case for builds), not only pid 1.
        let output = task::spawn_blocking(move || {
            Command::new("docker")
                .arg("inspect")
                .arg("--format")
                .arg("{{.State.OOMKilled}}")
                .arg(&container_id)
                .output()
        })
        .await??;
        if !output.status.success() {
            return Ok(None);
        }
        match String::from_utf8_lossy(&output.stdout).trim() {
            "true" => Ok(Some(true)),
            "false" => Ok(Some(false)),
            _ => Ok(None),
        }
    }
}

fn resolve_path_search(path: &Path, require_exists: bool) -> anyhow::Result<PathBuf> {
    if path.is_absolute() {
        if require_exists && !path.exists() {
            anyhow::bail!("path {:?} does not exist", path);
        }
        return Ok(path.to_path_buf());
    }

    let start_dir = std::env::current_dir()?;
    let mut dir = start_dir.clone();
    loop {
        let candidate = dir.join(path);
        if !require_exists || candidate.exists() {
            return Ok(candidate);
        }
        if !dir.pop() {
            break;
        }
    }

    if require_exists {
        anyhow::bail!("unable to locate {:?} relative to {:?}", path, start_dir);
    }

    Ok(start_dir.join(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_request(metadata: Option<JsonValue>) -> EnsureRuntimeRequest {
        EnsureRuntimeRequest {
            project_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            lease_id: Uuid::new_v4(),
            provider: "hosted".to_string(),
            runtime_token: "runtime-token".to_string(),
            metadata,
            origin_instance_id: Some(Uuid::new_v4()),
            origin_mode: None,
            origin_protocols: Vec::new(),
            origin_metadata: None,
        }
    }

    fn env_value<'a>(envs: &'a [(String, String)], key: &str) -> Option<&'a str> {
        envs.iter()
            .find(|(env_key, _)| env_key == key)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn resolve_runtime_agent_image_reads_camel_case_key() {
        let metadata = json!({
            "runtimeAgentImage": "ghcr.io/instafy-dev/instafy-runtime-agent:webdev"
        });
        assert_eq!(
            resolve_runtime_agent_image(&metadata),
            Some("ghcr.io/instafy-dev/instafy-runtime-agent:webdev".to_string())
        );
    }

    #[test]
    fn resolve_runtime_agent_image_reads_snake_case_key() {
        let metadata = json!({
            "runtime_agent_image": "ghcr.io/instafy-dev/instafy-runtime-agent:latest"
        });
        assert_eq!(
            resolve_runtime_agent_image(&metadata),
            Some("ghcr.io/instafy-dev/instafy-runtime-agent:latest".to_string())
        );
    }

    #[test]
    fn resolve_runtime_agent_image_rejects_unsafe_values() {
        for value in [
            "",
            " ",
            "ghcr.io/instafy-dev/instafy-runtime-agent:latest extra",
            "ghcr.io/instafy-dev/instafy-runtime-agent:'latest'",
            "ghcr.io/instafy-dev/instafy-runtime-agent:\\latest",
        ] {
            let metadata = json!({ "runtimeAgentImage": value });
            assert_eq!(resolve_runtime_agent_image(&metadata), None);
        }
    }

    #[test]
    fn build_env_uses_provider_runtime_agent_image_when_metadata_absent() {
        let mut config = ProviderConfig::default_docker();
        config.runtime_agent_image =
            Some("ghcr.io/instafy-dev/instafy-runtime-agent:release".to_string());
        let allocator = DockerRuntimeAllocator::new(&config).expect("allocator");
        let envs = allocator
            .build_env(&sample_request(None), 54332)
            .expect("runtime env");

        assert_eq!(
            env_value(&envs, "RUNTIME_AGENT_IMAGE"),
            Some("ghcr.io/instafy-dev/instafy-runtime-agent:release")
        );
        assert_eq!(env_value(&envs, "ORIGIN_ACCESS_TOKEN"), None);
        assert_eq!(
            env_value(&envs, "ORIGIN_INTERNAL_TOKEN"),
            Some("runtime-token")
        );
    }

    #[test]
    fn build_env_prefers_metadata_runtime_agent_image_over_provider_env() {
        let mut config = ProviderConfig::default_docker();
        config.runtime_agent_image =
            Some("ghcr.io/instafy-dev/instafy-runtime-agent:provider".to_string());
        let allocator = DockerRuntimeAllocator::new(&config).expect("allocator");
        let envs = allocator
            .build_env(
                &sample_request(Some(json!({
                    "runtimeAgentImage": "ghcr.io/instafy-dev/instafy-runtime-agent:request",
                    "env": {
                        "INSTAFY_SHARED_BROWSER_APPROVAL_DIR": "/srv/custom/approvals",
                        "DOCKER_HOST": "tcp://custom-docker.test:2375",
                        "RUNTIME_AGENT_BUILD_TARGET": "runtime-custom"
                    }
                }))),
                54332,
            )
            .expect("runtime env");

        assert_eq!(
            env_value(&envs, "RUNTIME_AGENT_IMAGE"),
            Some("ghcr.io/instafy-dev/instafy-runtime-agent:request")
        );
        assert_eq!(
            env_value(&envs, "INSTAFY_SHARED_BROWSER_APPROVAL_DIR"),
            Some("/srv/custom/approvals")
        );
        assert_eq!(
            env_value(&envs, "DOCKER_HOST"),
            Some("tcp://custom-docker.test:2375")
        );
        assert_eq!(
            env_value(&envs, "RUNTIME_AGENT_BUILD_TARGET"),
            Some("runtime-custom")
        );
    }

    #[test]
    fn managed_webdev_uses_provider_pinned_image_and_ignores_spoofed_env() {
        let mut config = ProviderConfig::default_docker();
        config.runtime_agent_image = Some("runtime-agent:base-sha".to_string());
        config.runtime_agent_webdev_image = Some("runtime-agent:webdev-sha".to_string());
        let allocator = DockerRuntimeAllocator::new(&config).expect("allocator");
        let lease_id = Uuid::new_v4();
        let mut request = sample_request(Some(json!({
            "runtimeFlavor": "webdev",
            "runtimeAgentImage": "attacker/image:direct",
            "_instafyManagedRuntimeLaunch": {
                "version": 1,
                "flavor": "webdev",
                "generation": lease_id.to_string(),
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
                "COMPOSE_PROJECT_NAME": "attacker-project",
                "BUILDKIT_HOST": "tcp://attacker.test:1234",
                "PATH": "/tmp/attacker-bin",
                "HOME": "/tmp/attacker-home",
                "BASH_ENV": "/tmp/attacker-shell-init",
                "LD_PRELOAD": "/tmp/attacker.so",
                "HTTP_PROXY": "http://attacker.test:8080",
                "HTTPS_PROXY": "http://attacker.test:8443",
                "ALL_PROXY": "socks5://attacker.test:1080",
                "NO_PROXY": "controller.internal",
                "PROXY_BASE_URL": "https://attacker.test/v1",
                "RUNTIME_AGENT_BUILD_TARGET": "attacker-target",
                "RUNTIME_AGENT_FORCE_BUILD": "1",
                "CODEX_SANDBOX_MODE": "workspace-write",
                "INSTAFY_ENABLE_BROWSER_SESSION": "1",
                "INSTAFY_BROWSER_VIEWPORT_ONLY": true,
                "INSTAFY_BROWSER_CDP_SCREENCAST": 1,
                "INSTAFY_VNC_PORT": 5900,
                "INSTAFY_VNC_GEOMETRY": {"width": 1280},
                "RUNTIME_CPU_LIMIT": "2",
                "RUNTIME_MEMORY_LIMIT": "4g",
            }
        })));
        request.provider = "instafy-cloud".to_string();
        request.lease_id = lease_id;

        let envs = allocator.build_env(&request, 54332).expect("runtime env");
        assert_eq!(
            env_value(&envs, "RUNTIME_AGENT_IMAGE"),
            Some("runtime-agent:webdev-sha")
        );
        assert_eq!(env_value(&envs, "RUNTIME_CAPABILITIES"), None);
        assert_eq!(env_value(&envs, "INSTAFY_BROWSER_AGENT_CONTROL_FILE"), None);
        assert_eq!(
            env_value(&envs, "INSTAFY_SHARED_BROWSER_APPROVAL_DIR"),
            None
        );
        assert_eq!(
            env_value(&envs, "INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS"),
            None
        );
        assert_eq!(
            env_value(&envs, "INSTAFY_ENABLE_BROWSER_SESSION"),
            Some("1")
        );
        assert_eq!(env_value(&envs, "INSTAFY_BROWSER_VIEWPORT_ONLY"), Some("1"));
        assert_eq!(
            env_value(&envs, "INSTAFY_BROWSER_CDP_SCREENCAST"),
            Some("1")
        );
        assert_eq!(env_value(&envs, "INSTAFY_VNC_PORT"), Some("5900"));
        assert_eq!(env_value(&envs, "RUNTIME_CPU_LIMIT"), Some("2"));
        assert_eq!(env_value(&envs, "RUNTIME_MEMORY_LIMIT"), Some("4g"));
        for key in [
            "DOCKER_HOST",
            "DOCKER_CONFIG",
            "COMPOSE_FILE",
            "COMPOSE_PROJECT_NAME",
            "BUILDKIT_HOST",
            "PATH",
            "HOME",
            "BASH_ENV",
            "LD_PRELOAD",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "PROXY_BASE_URL",
            "RUNTIME_AGENT_BUILD_TARGET",
            "RUNTIME_AGENT_FORCE_BUILD",
            "CODEX_SANDBOX_MODE",
            "INSTAFY_VNC_GEOMETRY",
        ] {
            assert_eq!(env_value(&envs, key), None, "retained {key}");
        }

        let serialized_metadata = env_value(&envs, "RUNTIME_METADATA").expect("metadata");
        let parsed_metadata: JsonValue =
            serde_json::from_str(serialized_metadata).expect("serialized metadata JSON");
        assert_eq!(parsed_metadata["env"]["INSTAFY_BROWSER_VIEWPORT_ONLY"], "1");
        assert_eq!(
            parsed_metadata["env"]["INSTAFY_BROWSER_CDP_SCREENCAST"],
            "1"
        );
        assert_eq!(parsed_metadata["env"]["INSTAFY_VNC_PORT"], "5900");
        for key in ["DOCKER_HOST", "PATH", "RUNTIME_AGENT_BUILD_TARGET"] {
            assert!(
                !serialized_metadata.contains(key),
                "serialized metadata retained {key}"
            );
        }
    }

    #[test]
    fn managed_webdev_rejects_spoofed_or_missing_lease_generation() {
        let mut config = ProviderConfig::default_docker();
        config.runtime_agent_webdev_image = Some("runtime-agent:webdev-sha".to_string());
        let allocator = DockerRuntimeAllocator::new(&config).expect("allocator");
        let mut request = sample_request(Some(json!({
            "runtimeFlavor": "webdev",
            "_instafyManagedRuntimeLaunch": {
                "version": 1,
                "flavor": "webdev",
                "generation": Uuid::new_v4().to_string(),
            }
        })));
        request.provider = "instafy-cloud".to_string();

        assert!(allocator.build_env(&request, 54332).is_err());
    }

    #[test]
    fn exact_managed_base_ignores_caller_image_and_capability_overrides() {
        let mut config = ProviderConfig::default_docker();
        config.runtime_agent_image = Some("runtime-agent:base-sha".to_string());
        let allocator = DockerRuntimeAllocator::new(&config).expect("allocator");
        let mut request = sample_request(Some(json!({
            "runtimeAgentImage": "attacker/image:direct",
            "env": {
                "RUNTIME_AGENT_IMAGE": "attacker/image:env",
                "RUNTIME_CAPABILITIES": "{\"spoofed\":true}",
            }
        })));
        request.provider = "instafy-cloud".to_string();

        let envs = allocator.build_env(&request, 54332).expect("runtime env");
        assert_eq!(
            env_value(&envs, "RUNTIME_AGENT_IMAGE"),
            Some("runtime-agent:base-sha")
        );
        assert_eq!(env_value(&envs, "RUNTIME_CAPABILITIES"), None);
    }

    #[test]
    fn parse_prefixed_resource_ids_filters_by_prefix() {
        let raw = "id-1\tinstafy-runtime-foo_default\nid-2\tinstafy-runtime_default\nid-3\tother\n";
        assert_eq!(
            parse_prefixed_resource_ids(raw, "instafy-runtime-"),
            vec!["id-1".to_string()]
        );
    }

    #[test]
    fn parse_stale_runtime_container_ids_skips_fresh_running_containers() {
        let raw = concat!(
            "id-1\tinstafy-runtime-foo-runtime-1\tExited (0) 2 seconds ago\n",
            "id-2\tinstafy-runtime-foo-proxy-1\tCreated\n",
            "id-3\tinstafy-runtime-foo-runtime-2\tUp 10 seconds\n",
            "id-4\tother-runtime\tExited (1) 5 seconds ago\n",
            "id-5\tinstafy-runtime-redis-1\tExited (0) 2 seconds ago\n",
            "id-6\tinstafy-runtime-foo-runtime-1\tUp 7 hours\n",
        );
        assert_eq!(
            parse_stale_runtime_container_ids(raw, "instafy-runtime-"),
            vec!["id-1".to_string(), "id-2".to_string()]
        );
    }

    #[test]
    fn parse_stale_runtime_container_ids_cleans_old_running_runtime_containers() {
        let raw = concat!(
            "id-1\tinstafy-runtime-foo-runtime-1\tUp 25 hours\n",
            "id-2\tinstafy-runtime-foo-proxy-1\tUp 2 days\n",
            "id-3\tinstafy-runtime-foo-runtime-1\tUp About an hour\n",
            "id-4\tinstafy-runtime-redis-1\tUp 8 days\n",
        );
        assert_eq!(
            parse_stale_runtime_container_ids(raw, "instafy-runtime-"),
            vec!["id-1".to_string(), "id-2".to_string()]
        );
    }

    #[test]
    fn clip_command_output_keeps_tail_of_long_output() {
        let raw = format!(
            "{}final docker error",
            "x".repeat(DOCKER_COMMAND_OUTPUT_LIMIT + 32)
        );
        let clipped = clip_command_output(&raw);

        assert!(clipped.starts_with('…'));
        assert!(clipped.ends_with("final docker error"));
        assert!(clipped.len() <= DOCKER_COMMAND_OUTPUT_LIMIT + "…".len());
    }

    #[test]
    fn docker_allocator_reads_controller_base_url_from_env() {
        let key = "CONTROLLER_BASE_URL";
        let previous = std::env::var(key).ok();
        unsafe {
            std::env::set_var(key, "http://host.docker.internal:8788");
        }

        let allocator = DockerRuntimeAllocator::new(&ProviderConfig::default_docker()).unwrap();
        assert_eq!(
            allocator.controller_base_url.as_deref(),
            Some("http://host.docker.internal:8788")
        );

        if let Some(value) = previous {
            unsafe {
                std::env::set_var(key, value);
            }
        } else {
            unsafe {
                std::env::remove_var(key);
            }
        }
    }

    #[tokio::test]
    async fn failed_compose_down_is_propagated_after_local_port_cleanup() {
        let allocator = DockerRuntimeAllocator::new(&ProviderConfig::default_docker()).unwrap();
        let runtime_id = Uuid::new_v4();
        allocator
            .assigned_ports
            .lock()
            .await
            .insert(runtime_id, 54321);

        let result = allocator
            .finalize_runtime_stop(
                runtime_id,
                Err(anyhow::anyhow!("compose down sentinel failure")),
            )
            .await;

        assert_eq!(
            result
                .expect_err("compose down failure must propagate")
                .to_string(),
            "compose down sentinel failure"
        );
        assert!(!allocator
            .assigned_ports
            .lock()
            .await
            .contains_key(&runtime_id));
    }
}
