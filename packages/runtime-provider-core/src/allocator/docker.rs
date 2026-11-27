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

use super::address_pools::{
    is_address_pool_exhaustion, reclaim_runtime_address_space, ControllerSpaceDirectory, DockerCli,
    NoSpaceDirectory, ReclaimedAddressSpace, SpaceDirectory, SystemDocker,
};
use super::census::{
    group_containers, identity_env_from_inspect, lease_id_from_inspect, ContainerFacts,
    RuntimeCensus, CONFIG_ENV_FORMAT, MAX_CENSUS_CONTAINERS,
};
use super::checkout_eviction::{
    sweep_checkouts, touch_checkout, CheckoutEvictionPolicy, CheckoutHost, CheckoutSweepReport,
};
use super::{
    canonical_managed_runtime_env_value, is_allowed_managed_runtime_env_key,
    is_exact_managed_provider, managed_webdev_generation_matches, runtime_metadata_for_process,
    EnsureRuntimeOutcome, EnsureRuntimeRequest, RuntimeAllocator, MANAGED_RUNTIME_FLAVOR_KEY,
    MANAGED_RUNTIME_LAUNCH_ATTESTATION, MANAGED_RUNTIME_WEBDEV_FLAVOR,
};
use crate::config::ProviderConfig;

const DOCKER_COMMAND_OUTPUT_LIMIT: usize = 8_000;

/// The port a runtime's origin listens on inside its container; the compose
/// file publishes it on the node at the runtime's own host port.
const ORIGIN_CONTAINER_PORT: u16 = 54332;

/// How the node reaches a runtime origin published at `host_port`: through
/// its host gateway, which every process on the node can reach, in a
/// container or not.
fn node_local_origin_endpoint(host_port: u16) -> String {
    format!("http://host.docker.internal:{host_port}")
}

/// Whether the controller this node's runtimes call (`CONTROLLER_BASE_URL`,
/// or `PROXY_CONTROLLER_BASE_URL` when that is unset) runs on this node:
/// unset (the compose file's host-gateway default), or
/// naming the host gateway, `localhost` or a loopback address. An address
/// from [`node_local_origin_endpoint`] means this node, so only a controller
/// here may be told one: any other controller would read it as its own
/// host and send a stop's save credential to the wrong machine.
fn controller_on_this_node(controller_base_url: Option<&str>) -> bool {
    let Some(base) = controller_base_url else {
        return true;
    };
    let Some(host) = Url::parse(base.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
    else {
        return false;
    };
    host == "host.docker.internal"
        || host == "localhost"
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// The host port in `docker port <container> <port>/tcp` output, as
/// `0.0.0.0:49153` or `[::]:49153`, one binding per line.
fn published_host_port(output: &str) -> Option<u16> {
    output
        .lines()
        .filter_map(|line| line.trim().rsplit_once(':'))
        .find_map(|(_, port)| port.parse::<u16>().ok().filter(|port| *port != 0))
}

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
    /// For a provider other than exact instafy_cloud, a launch request's
    /// `metadata.runtimeAgentImage` picks the image (`RUNTIME_AGENT_IMAGE_FROM_REQUEST`).
    runtime_agent_image_from_request: bool,
    compose_semaphore: Arc<Semaphore>,
    assigned_ports: Mutex<HashMap<Uuid, u16>>,
    runtime_operation_locks: Mutex<HashMap<Uuid, Arc<Mutex<()>>>>,
    checkout_eviction: CheckoutEvictionPolicy,
    /// Held by a start for its project's checkout, and by the eviction sweep
    /// while it decides about and removes a checkout.
    checkout_locks: CheckoutLocks,
    /// Which spaces are gone, for a start that ran out of address pools
    /// (see [`super::address_pools`]).
    space_directory: Arc<dyn SpaceDirectory>,
}

type CheckoutLocks = Arc<std::sync::Mutex<HashMap<Uuid, Arc<Mutex<()>>>>>;

fn checkout_lock(locks: &CheckoutLocks, project_id: Uuid) -> Arc<Mutex<()>> {
    locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(project_id)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// The node as the checkout eviction sweep sees it: per-project start locks
/// and the Docker containers of each project.
struct DockerCheckoutHost {
    project_prefix: String,
    locks: CheckoutLocks,
}

impl CheckoutHost for DockerCheckoutHost {
    type Claim = tokio::sync::OwnedMutexGuard<()>;

    fn claim(&self, project_id: Uuid) -> Option<Self::Claim> {
        checkout_lock(&self.locks, project_id).try_lock_owned().ok()
    }

    fn runtime_present(&self, project_id: Uuid) -> anyhow::Result<bool> {
        // Compose project names are `<prefix><project id, simple>-<runtime>`,
        // and their containers are named after the project.
        let prefix = format!("{}{}-", self.project_prefix, project_id.simple());
        let output = Command::new("docker")
            .arg("ps")
            .arg("-a")
            .arg("--filter")
            .arg(format!("name={prefix}"))
            .arg("--format")
            .arg("{{.Names}}")
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "docker ps failed: {}",
            summarize_command_output(&output)
        );
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|name| name.trim().trim_start_matches('/').starts_with(&prefix)))
    }
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
            runtime_agent_image_from_request: config.runtime_agent_image_from_request,
            compose_semaphore: Arc::new(Semaphore::new(max_ops)),
            assigned_ports: Mutex::new(HashMap::new()),
            runtime_operation_locks: Mutex::new(HashMap::new()),
            checkout_eviction: config.runtime_checkout_eviction.clone(),
            checkout_locks: Arc::new(std::sync::Mutex::new(HashMap::new())),
            space_directory: match ControllerSpaceDirectory::from_env() {
                Some(directory) => Arc::new(directory),
                None => Arc::new(NoSpaceDirectory),
            },
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

        // A stop never evicts the checkout; it only starts its idle clock.
        // It holds the checkout's lock like a start, so an eviction sweep
        // that read the old clock cannot remove it as the stop finishes.
        let checkout_guard = checkout_lock(&self.checkout_locks, project_id)
            .lock_owned()
            .await;
        let compose_down_result = self.run_compose_down(&project_name).await;
        if let Some(repo_base) = &self.repo_base {
            touch_checkout(repo_base, project_id);
        }
        drop(checkout_guard);
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
        let container_id = container_id.to_string();
        let output = task::spawn_blocking(move || {
            Command::new("docker")
                .arg("inspect")
                .arg("--format")
                .arg(CONFIG_ENV_FORMAT)
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

        Ok(lease_id_from_inspect(&output.stdout))
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
        let runtime_image_name = envs
            .iter()
            .find(|(key, _)| key == "RUNTIME_AGENT_IMAGE")
            .map(|(_, value)| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "runtime-agent:local".to_string());
        let space_directory = self.space_directory.clone();
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

            // The allocator never builds the runtime image: the one it starts must already be on
            // this node, or be pulled here, and every `up` runs with --no-build.
            if image_ref_looks_remote(&runtime_image_name) {
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

            reclaim_after_failed_start(
                &SystemDocker,
                &project_prefix,
                &project_name,
                space_directory.as_ref(),
                &summarize_command_output(&first_output),
            );

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
        envs.push((
            "ORIGIN_BIND_PORT".to_string(),
            ORIGIN_CONTAINER_PORT.to_string(),
        ));
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
        if let Some(raw) = request
            .origin_mode
            .as_deref()
            .filter(|raw| !raw.trim().is_empty())
        {
            match known_origin_mode(raw) {
                Some(mode) => envs.push(("ORIGIN_MODE".to_string(), mode.to_string())),
                None => warn!(
                    "runtime launch request names an origin mode the runtime does not know; \
                     it starts in the mode the provider service's environment or its compose \
                     file sets"
                ),
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
            .unwrap_or_else(|| node_local_origin_endpoint(host_port));

        envs.push(("ORIGIN_ENDPOINT".to_string(), endpoint));

        if let Some(url) = &self.controller_base_url {
            envs.push(("CONTROLLER_BASE_URL".to_string(), url.clone()));
        }
        let managed_webdev_image = self.managed_webdev_image(request)?;
        let exact_managed_provider = is_exact_managed_provider(&request.provider);
        let mut process_metadata =
            runtime_metadata_for_process(&request.provider, request.metadata.as_ref());
        // What the provider set above (the runtime's ids, its token, the controller and origin
        // addresses) stays as the provider set it.
        let provider_set: HashSet<String> = envs.iter().map(|(key, _)| key.clone()).collect();
        let request_env = process_metadata
            .as_ref()
            .map(|meta| request_compose_env(exact_managed_provider, meta, &provider_set))
            .unwrap_or_default();
        let runtime_image = match managed_webdev_image {
            Some(image) => Some(image),
            None => self
                .requested_runtime_agent_image(exact_managed_provider, process_metadata.as_ref()),
        }
        .or_else(|| self.runtime_agent_image.clone());
        if let Some(meta) = process_metadata.as_mut() {
            // The runtime's own copy of its launch metadata carries, as its env, what the request
            // set here, and nothing the request was refused; an env that is no object set nothing.
            if let Some(root) = meta.as_object_mut() {
                if root.get("env").is_some_and(JsonValue::is_object) {
                    root.insert(
                        "env".to_string(),
                        JsonValue::Object(
                            request_env
                                .iter()
                                .map(|(key, value)| (key.clone(), JsonValue::String(value.clone())))
                                .collect(),
                        ),
                    );
                } else {
                    root.remove("env");
                }
            }
            envs.push(("RUNTIME_METADATA".to_string(), json_env_value(meta)));
        }
        if let Some(runtime_image) = runtime_image {
            envs.push(("RUNTIME_AGENT_IMAGE".to_string(), runtime_image));
        }
        envs.extend(request_env);

        // The provider alone picks the host directories it mounts into the runtime: a request
        // cannot set RUNTIME_REPO_HOST or RUNTIME_CACHE_HOST.
        if let Some(repo_base) = &self.repo_base {
            let project_repo = repo_base.join(request.project_id.to_string());
            std::fs::create_dir_all(&project_repo)?;
            touch_checkout(repo_base, request.project_id);
            envs.push((
                "RUNTIME_REPO_HOST".to_string(),
                project_repo.to_string_lossy().to_string(),
            ));
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

        let origin_id = request
            .origin_instance_id
            .ok_or_else(|| anyhow::anyhow!("origin instance id missing for docker allocator"))?;
        envs.push(("ORIGIN_ID".to_string(), origin_id.to_string()));
        envs.push(("ORIGIN_LEASE_ID".to_string(), request.lease_id.to_string()));
        let protocols: Vec<&str> = request
            .origin_protocols
            .iter()
            .map(String::as_str)
            .filter(|protocol| is_origin_protocol_name(protocol))
            .collect();
        if protocols.len() != request.origin_protocols.len() {
            warn!(
                refused = request.origin_protocols.len() - protocols.len(),
                "runtime launch request names origin protocols that are no protocol names; \
                 the runtime starts without them"
            );
        }
        if !protocols.is_empty() {
            envs.push(("ORIGIN_PROTOCOLS".to_string(), protocols.join(",")));
        }
        if let Some(origin_meta) = request.origin_metadata.as_ref() {
            envs.push(("ORIGIN_METADATA".to_string(), json_env_value(origin_meta)));
        }

        Ok(envs)
    }

    /// The runtime image a launch request names (`metadata.runtimeAgentImage`), for a provider
    /// other than exact instafy_cloud that lets a request choose it
    /// (`RUNTIME_AGENT_IMAGE_FROM_REQUEST`). The image decides all the code a runtime runs, the
    /// turns of every member it serves included, so without that the provider's own image
    /// applies.
    fn requested_runtime_agent_image(
        &self,
        exact_managed_provider: bool,
        metadata: Option<&JsonValue>,
    ) -> Option<String> {
        if exact_managed_provider {
            return None;
        }
        let requested = resolve_runtime_agent_image(metadata?)?;
        if self.runtime_agent_image_from_request {
            return Some(requested);
        }
        if self.runtime_agent_image.is_some() {
            warn!(
                "runtime launch request names a runtime image; this provider starts its own \
                 RUNTIME_AGENT_IMAGE (RUNTIME_AGENT_IMAGE_FROM_REQUEST is off)"
            );
        } else {
            warn!(
                "runtime launch request names a runtime image, but \
                 RUNTIME_AGENT_IMAGE_FROM_REQUEST is off and this provider names no \
                 RUNTIME_AGENT_IMAGE: Compose starts its compose file's default image, or fails \
                 where the file has none"
            );
        }
        None
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

/// Before a failed start's retry: when Docker ran out of address pools,
/// free what no space needs ([`reclaim_runtime_address_space`]) so the retry
/// can get a subnet. Any other failure reclaims nothing. Never fails the
/// start: what it could not do is logged.
fn reclaim_after_failed_start(
    cli: &dyn DockerCli,
    prefix: &str,
    starting: &str,
    spaces: &dyn SpaceDirectory,
    failure: &str,
) -> Option<ReclaimedAddressSpace> {
    if !is_address_pool_exhaustion(failure) {
        return None;
    }
    match reclaim_runtime_address_space(cli, prefix, starting, spaces) {
        Ok(reclaimed) => {
            warn!(
                project_name = %starting,
                removed_projects = reclaimed.projects.len(),
                removed_networks = reclaimed.networks.len(),
                "docker ran out of address pools; freed runtime networks before retrying"
            );
            Some(reclaimed)
        }
        Err(error) => {
            warn!(
                project_name = %starting,
                %error,
                "docker ran out of address pools and the runtime networks could not be listed"
            );
            None
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

/// Managed launch keys that, for a provider other than exact instafy_cloud, only the provider's
/// operator sets, in the provider service's own environment: the Shared Browser's egress
/// policy, the host the origin reaches its VNC server at, and the display's colour depth. For
/// exact instafy_cloud the controller strips a client's value of each before the provider row
/// adds its own; for any other provider a client's value would arrive with the row's and win
/// over it.
const EXACT_ONLY_LAUNCH_ENV_KEYS: &[&str] = &[
    "INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS",
    "INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV",
    "INSTAFY_BROWSER_EGRESS_ISOLATION",
    "INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS",
    "INSTAFY_BROWSER_EGRESS_PROXY_BIND",
    "INSTAFY_VNC_DEPTH",
    "INSTAFY_VNC_HOST",
];

/// The variables a runtime compose file passes into the runtime container that a launch request
/// never sets, for any provider. The provider sets some itself (the runtime's ids, its token, its
/// addresses); the others only its operator sets, in the provider service's own environment,
/// which `docker compose` inherits: the runtime's model routing, its agent's sandbox, tools and
/// model, its timings, capabilities and credentials. A shared runtime runs the turns of every
/// member it serves, so none of them is a launch's to choose. build_env never consults this list
/// (it takes from a request only the managed launch keys); a test here holds build_env to it, and
/// scripts/check-self-host-compose.test.mjs holds both runtime compose files to it: each variable
/// they pass only into the runtime container is a managed launch key, one of these or one of
/// REQUEST_DERIVED_RUNTIME_ENV_KEYS.
#[cfg(test)]
const OPERATOR_ONLY_RUNTIME_ENV_KEYS: &[&str] = &[
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
    "INSTAFY_HOLD_PAGES",
    "INSTAFY_PLAYWRIGHT_MCP_ALLOW_ISOLATED",
    "INSTAFY_PLAYWRIGHT_MCP_MODE",
    "INSTAFY_PLAYWRIGHT_MCP_PORT",
    "INSTAFY_PLAYWRIGHT_MCP_PROFILE_DIR",
    "INSTAFY_RESEARCH_PAGES_SEARCH_FIRST",
    "OPENAI_BASE_URL",
    "ORIGIN_BIND_HOST",
    "ORIGIN_BIND_PORT",
    "ORIGIN_DEVICE_ID",
    "ORIGIN_ENABLE_PRESENCE_HEARTBEAT",
    "ORIGIN_ENDPOINT",
    "ORIGIN_ID",
    "ORIGIN_LEASE_ID",
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
    "RUNTIME_STRICT_MODE",
    "RUNTIME_TYPE",
    "RUNTIME_VERSION",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "USE_PROXY_FOR_LLM",
];

/// The variables build_env derives from a launch request's own fields rather than from its
/// `metadata.env`: the runtime's copy of its launch metadata, and its origin's mode, protocols
/// and metadata. scripts/check-self-host-compose.test.mjs keeps each inside the runtime
/// container, as it does the managed launch keys, and a test here shows the list complete.
#[cfg(test)]
const REQUEST_DERIVED_RUNTIME_ENV_KEYS: &[&str] = &[
    "ORIGIN_METADATA",
    "ORIGIN_MODE",
    "ORIGIN_PROTOCOLS",
    "RUNTIME_METADATA",
];

/// Whether a request's `metadata.env` entry joins the environment `docker compose` runs with.
/// Exact instafy_cloud takes the managed launch keys, with scalar values. Any other provider takes
/// them but the operator's browser policy (EXACT_ONLY_LAUNCH_ENV_KEYS), and takes the WebRTC
/// switch only as a string: the controller applies its relay policy to the string "1" alone,
/// while a `true` would turn WebRTC on here past it.
fn request_may_set_compose_env(exact_managed_provider: bool, key: &str, value: &JsonValue) -> bool {
    if exact_managed_provider {
        return is_allowed_managed_runtime_env_key(key)
            && canonical_managed_runtime_env_value(value).is_some();
    }
    is_allowed_managed_runtime_env_key(key)
        && !EXACT_ONLY_LAUNCH_ENV_KEYS.contains(&key)
        && (key != "INSTAFY_BROWSER_WEBRTC_ENABLED" || value.is_string())
}

/// A warning lists at most this many refused names, each cut to REFUSED_NAME_CHARS_LOGGED
/// characters, so that no launch floods the log.
const REFUSED_NAMES_LOGGED: usize = 16;
const REFUSED_NAME_CHARS_LOGGED: usize = 64;

/// The `metadata.env` entries of a request's metadata that join the environment `docker compose`
/// runs with, rendered, one per name. A null or empty value sets nothing. One warning lists the
/// names a launch may not set here (the provider sets some itself; an operator sets the others in
/// the provider service's own environment). A value is refused, with a warning that names its key
/// but never its value, when it would not reach the runtime as one line or, for the Shared
/// Browser's display, names anything but a local X display.
fn request_compose_env(
    exact_managed_provider: bool,
    metadata: &JsonValue,
    provider_set: &HashSet<String>,
) -> Vec<(String, String)> {
    let Some(env) = metadata.get("env").and_then(JsonValue::as_object) else {
        return Vec::new();
    };
    let mut accepted = Vec::new();
    let mut refused_names = Vec::new();
    for (key, value) in env {
        if value.is_null() || value.as_str() == Some("") {
            continue;
        }
        if provider_set.contains(key)
            || !request_may_set_compose_env(exact_managed_provider, key, value)
        {
            refused_names.push(key.as_str());
            continue;
        }
        let Some(rendered) = render_request_env_value(value) else {
            continue;
        };
        if let Some(reason) = refused_request_env_value(key, &rendered) {
            warn!(
                %key,
                reason,
                "runtime launch request value refused; the runtime starts without it"
            );
            continue;
        }
        accepted.push((key.clone(), rendered));
    }
    if !refused_names.is_empty() {
        let names: Vec<String> = refused_names
            .iter()
            .take(REFUSED_NAMES_LOGGED)
            .map(|name| name.chars().take(REFUSED_NAME_CHARS_LOGGED).collect())
            .collect();
        warn!(
            refused = refused_names.len(),
            ?names,
            "runtime launch request sets variables a launch may not set on this provider; the \
             runtime starts without them"
        );
    }
    accepted
}

/// A request's `metadata.env` value as the runtime receives it: a boolean as `1` or `0`, an array
/// or object as compact JSON, and a string that holds a JSON array or object laid out over
/// several lines (an ICE server list, say) as that JSON on one line.
fn render_request_env_value(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(text) => {
            if text.chars().any(breaks_env_line) {
                if let Ok(json @ (JsonValue::Array(_) | JsonValue::Object(_))) =
                    serde_json::from_str::<JsonValue>(text)
                {
                    return Some(json_env_value(&json));
                }
            }
            Some(text.clone())
        }
        JsonValue::Number(number) => Some(number.to_string()),
        JsonValue::Bool(flag) => Some(if *flag { "1" } else { "0" }.to_string()),
        JsonValue::Null => None,
        other => Some(json_env_value(other)),
    }
}

/// Why a rendered request value may not join the runtime's environment, if it may not.
fn refused_request_env_value(key: &str, value: &str) -> Option<&'static str> {
    if value.chars().any(breaks_env_line) {
        return Some("the value holds a control character or a line break");
    }
    if key == "INSTAFY_BROWSER_DISPLAY" && !is_local_x_display(value) {
        return Some("the display is not a local X display (:N)");
    }
    None
}

/// A character that can end a line, or that a reader may treat as one: every control character
/// (C0, DEL and C1, U+0085 among them) and the Unicode line and paragraph separators.
fn breaks_env_line(character: char) -> bool {
    character.is_control() || character == '\u{2028}' || character == '\u{2029}'
}

/// `:N` for a display number N from 0 to 9999, written without leading zeros: the runtime
/// derives its X lock and socket paths from the number as written.
fn is_local_x_display(value: &str) -> bool {
    let Some(number) = value.strip_prefix(':') else {
        return false;
    };
    (1..=4).contains(&number.len())
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && (number == "0" || !number.starts_with('0'))
}

/// `value` as compact JSON on one line. Compact JSON holds a control character or a Unicode line
/// separator only inside a string, where JSON allows it raw; each is written as its `\u` escape,
/// which stands for the same character.
fn json_env_value(value: &JsonValue) -> String {
    let compact = value.to_string();
    if !compact.chars().any(breaks_env_line) {
        return compact;
    }
    let mut escaped = String::with_capacity(compact.len() + 16);
    for character in compact.chars() {
        if breaks_env_line(character) {
            escaped.push_str(&format!("\\u{:04x}", u32::from(character)));
        } else {
            escaped.push(character);
        }
    }
    escaped
}

/// An origin mode the runtime knows, as it reads it.
fn known_origin_mode(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "hosted" => Some("hosted"),
        "desktop" => Some("desktop"),
        "efs" => Some("efs"),
        _ => None,
    }
}

/// A protocol name an origin may list: a lowercase letter, then up to 31 lowercase letters,
/// digits, `+`, `.` or `-`. The runtime reads the list split at its commas.
fn is_origin_protocol_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_lowercase)
        && bytes.len() <= 32
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'+' | b'.' | b'-')
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
    // A reference that starts with `-` would read as an option to the Docker CLI.
    if trimmed.starts_with('-')
        || trimmed.chars().any(|ch| {
            ch.is_whitespace() || breaks_env_line(ch) || ch == '"' || ch == '\'' || ch == '\\'
        })
    {
        return None;
    }
    Some(trimmed.to_string())
}

/// Every compose container under `prefix`, running or stopped, with its
/// environment. Returns them and whether the list reached its bound.
fn list_runtime_containers(prefix: &str) -> anyhow::Result<(Vec<ContainerFacts>, bool)> {
    let output = Command::new("docker")
        .arg("ps")
        .arg("-a")
        .arg("--filter")
        .arg("label=com.docker.compose.project")
        .arg("--format")
        .arg("{{.ID}}\t{{.Label \"com.docker.compose.project\"}}\t{{.State}}")
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "docker ps failed: {}",
        summarize_command_output(&output)
    );
    let mut facts = Vec::new();
    let mut truncated = false;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split('\t');
        let (Some(id), Some(project), Some(state)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if !project.starts_with(prefix) {
            continue;
        }
        if facts.len() >= MAX_CENSUS_CONTAINERS {
            truncated = true;
            break;
        }
        let inspect = Command::new("docker")
            .arg("inspect")
            .arg("--format")
            .arg(CONFIG_ENV_FORMAT)
            .arg(id.trim())
            .output()?;
        // A container removed since the listing has nothing left to report.
        let env = if inspect.status.success() {
            identity_env_from_inspect(&inspect.stdout)
        } else {
            Vec::new()
        };
        facts.push(ContainerFacts {
            compose_project: project.trim().to_string(),
            running: state.trim().eq_ignore_ascii_case("running"),
            env,
        });
    }
    Ok((facts, truncated))
}

/// The running containers of compose service `service` in compose project
/// `project`, from one read-only `docker ps` that takes no compose permit:
/// a stop's origin lookup never waits behind other runtimes' compose up or
/// down. The arguments are fixed; the names are matched here.
fn running_compose_service_containers(project: &str, service: &str) -> anyhow::Result<Vec<String>> {
    let output = Command::new("docker")
        .arg("ps")
        .arg("--filter")
        .arg("label=com.docker.compose.project")
        .arg("--filter")
        .arg("status=running")
        .arg("--format")
        .arg("{{.ID}}\t{{.Label \"com.docker.compose.project\"}}\t{{.Label \"com.docker.compose.service\"}}")
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "docker ps failed: {}",
        summarize_command_output(&output)
    );
    Ok(service_containers(
        &String::from_utf8_lossy(&output.stdout),
        project,
        service,
    ))
}

/// The container ids in `docker ps` lines of `<id>\t<project>\t<service>`
/// that belong to `service` in `project`.
fn service_containers(listing: &str, project: &str, service: &str) -> Vec<String> {
    listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let (Some(id), Some(listed_project), Some(listed_service)) =
                (fields.next(), fields.next(), fields.next())
            else {
                return None;
            };
            let id = id.trim();
            (!id.is_empty() && listed_project.trim() == project && listed_service.trim() == service)
                .then(|| id.to_string())
        })
        .collect()
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
        // The eviction sweep never removes a checkout a start holds.
        let _checkout_guard = checkout_lock(&self.checkout_locks, request.project_id)
            .lock_owned()
            .await;
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

    async fn census(&self) -> anyhow::Result<RuntimeCensus> {
        let prefix = self.project_prefix.clone();
        let (facts, truncated) =
            task::spawn_blocking(move || list_runtime_containers(&prefix)).await??;
        Ok(RuntimeCensus {
            supported: true,
            containers: group_containers(&self.project_prefix, facts),
            truncated,
        })
    }

    async fn evict_idle_checkouts(&self) -> anyhow::Result<CheckoutSweepReport> {
        let Some(repo_base) = self.repo_base.clone() else {
            return Ok(CheckoutSweepReport::default());
        };
        if !self.checkout_eviction.is_enabled() {
            return Ok(CheckoutSweepReport::default());
        }
        let policy = self.checkout_eviction.clone();
        let host = DockerCheckoutHost {
            project_prefix: self.project_prefix.clone(),
            locks: self.checkout_locks.clone(),
        };
        Ok(task::spawn_blocking(move || {
            sweep_checkouts(&repo_base, &policy, std::time::SystemTime::now(), &host)
        })
        .await?)
    }

    async fn origin_endpoint(
        &self,
        project_id: Uuid,
        runtime_id: Uuid,
        lease_id: Uuid,
    ) -> anyhow::Result<Option<String>> {
        // The answer is an address on this node; a controller elsewhere (a
        // provider registered with a remote one) would read it as its own.
        if !controller_on_this_node(self.controller_base_url.as_deref()) {
            return Ok(None);
        }
        let project_name = self.sanitize_project_name(project_id, runtime_id);
        let service = self.service_name.clone();
        let running = task::spawn_blocking(move || {
            running_compose_service_containers(&project_name, &service)
        })
        .await??;
        // One running container, of exactly that generation.
        let [container_id] = running.as_slice() else {
            return Ok(None);
        };
        if self.container_lease_id(container_id).await? != Some(lease_id) {
            return Ok(None);
        }
        let container_id = container_id.clone();
        let output = task::spawn_blocking(move || {
            Command::new("docker")
                .arg("port")
                .arg(&container_id)
                .arg(format!("{ORIGIN_CONTAINER_PORT}/tcp"))
                .output()
        })
        .await??;
        if !output.status.success() {
            return Ok(None);
        }
        Ok(
            published_host_port(&String::from_utf8_lossy(&output.stdout))
                .map(node_local_origin_endpoint),
        )
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

    #[test]
    fn the_origin_endpoint_is_the_published_port_on_the_host_gateway() {
        assert_eq!(
            published_host_port("0.0.0.0:49153\n[::]:49153\n"),
            Some(49153)
        );
        assert_eq!(published_host_port("[::]:40001\n"), Some(40001));
        assert_eq!(published_host_port(""), None);
        assert_eq!(published_host_port("0.0.0.0:0\n"), None);
        assert_eq!(published_host_port("no such port\n"), None);
        assert_eq!(
            published_host_port("49153").map(node_local_origin_endpoint),
            None
        );
        assert_eq!(
            node_local_origin_endpoint(49153),
            "http://host.docker.internal:49153"
        );
    }

    /// Only a controller on this node may be told an origin address on it.
    #[test]
    fn only_a_controller_on_this_node_is_told_where_an_origin_is() {
        for base in [
            None,
            Some("http://host.docker.internal:80"),
            Some("http://HOST.docker.internal:8788/"),
            Some("http://localhost:8788"),
            Some("http://127.0.0.1:8788"),
            Some("http://127.1.2.3"),
            Some("http://[::1]:8788"),
        ] {
            assert!(controller_on_this_node(base), "{base:?}");
        }
        for base in [
            Some("https://controller.example.com"),
            Some("http://10.0.0.5:8788"),
            Some("http://192.168.1.20:8788"),
            Some("http://instafy-controller:8788"),
            Some("http://[fd00::1]:8788"),
            Some("not a url"),
            Some(""),
        ] {
            assert!(!controller_on_this_node(base), "{base:?}");
        }
    }

    /// A provider whose runtimes call a controller elsewhere answers no
    /// origin, before it looks at any container.
    #[tokio::test]
    async fn a_remote_controller_is_told_no_origin() {
        let mut allocator = DockerRuntimeAllocator::new(&ProviderConfig::default_docker()).unwrap();
        allocator.controller_base_url = Some("https://controller.example.com".to_string());
        let answer = allocator
            .origin_endpoint(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4())
            .await
            .expect("answered without looking at containers");
        assert_eq!(answer, None);
    }

    /// A stop's origin lookup reads containers without a compose permit, so
    /// it answers while other runtimes' compose up or down hold every one.
    #[tokio::test]
    async fn the_origin_lookup_never_waits_for_compose_operations() {
        let mut allocator = DockerRuntimeAllocator::new(&ProviderConfig::default_docker()).unwrap();
        allocator.controller_base_url = None;
        allocator.project_prefix = "origin-lookup-test-".to_string();
        let permits = allocator.compose_semaphore.available_permits() as u32;
        let _held = allocator
            .compose_semaphore
            .clone()
            .acquire_many_owned(permits)
            .await
            .unwrap();
        // Without Docker here the lookup fails; either way it answers.
        let answer = tokio::time::timeout(
            Duration::from_secs(20),
            allocator.origin_endpoint(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()),
        )
        .await
        .expect("the lookup waited for a compose permit");
        if let Ok(endpoint) = answer {
            assert_eq!(endpoint, None, "no such runtime here");
        }
    }

    #[test]
    fn the_origin_lookup_keeps_only_that_projects_service() {
        let listing = "aaa\tinstafy-runtime-p-1\truntime\n\
                       bbb\tinstafy-runtime-p-1\tproxy\n\
                       ccc\tinstafy-runtime-p-10\truntime\n\
                       \tinstafy-runtime-p-1\truntime\n\
                       ddd\tinstafy-runtime-p-1\n\
                       eee\tinstafy-runtime-p-1\truntime\n";
        assert_eq!(
            service_containers(listing, "instafy-runtime-p-1", "runtime"),
            vec!["aaa".to_string(), "eee".to_string()]
        );
        assert!(service_containers("", "instafy-runtime-p-1", "runtime").is_empty());
    }

    fn env_value<'a>(envs: &'a [(String, String)], key: &str) -> Option<&'a str> {
        envs.iter()
            .find(|(env_key, _)| env_key == key)
            .map(|(_, value)| value.as_str())
    }

    /// build_env for `request`. `docker compose` runs with the last value of a name build_env
    /// lists, while `env_value` and the image pull read the first, so each name must appear once.
    fn launch_env(
        allocator: &DockerRuntimeAllocator,
        request: &EnsureRuntimeRequest,
    ) -> Vec<(String, String)> {
        let envs = allocator.build_env(request, 54332).expect("runtime env");
        let mut seen = HashSet::new();
        for (name, _) in &envs {
            assert!(seen.insert(name.as_str()), "{name} is set more than once");
        }
        envs
    }

    /// The managed launch keys a launch request sets for a provider other than exact
    /// instafy_cloud (all of them but EXACT_ONLY_LAUNCH_ENV_KEYS), each with a value it may take.
    const CUSTOM_LAUNCH_ENV: &[(&str, &str)] = &[
        ("INSTAFY_BROWSER_CDP_SCREENCAST", "1"),
        ("INSTAFY_BROWSER_DISPLAY", ":1"),
        ("INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS", "2073600"),
        ("INSTAFY_BROWSER_PREFERRED_VIEWER", "webrtc"),
        ("INSTAFY_BROWSER_PROFILE_PERSIST", "0"),
        ("INSTAFY_BROWSER_PROFILE_SNAPSHOT_SECS", "30"),
        ("INSTAFY_BROWSER_RENDER_SCALE", "1.5"),
        ("INSTAFY_BROWSER_VIEWPORT_ONLY", "1"),
        ("INSTAFY_BROWSER_WEBRTC_BIND", "127.0.0.1:9225"),
        ("INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS", "2500"),
        ("INSTAFY_BROWSER_WEBRTC_ENABLED", "1"),
        ("INSTAFY_BROWSER_WEBRTC_FPS", "30"),
        (
            "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON",
            r#"[{"urls":["stun:stun.example.test:19302"]}]"#,
        ),
        ("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN", "1"),
        ("INSTAFY_BROWSER_WEBRTC_SENDER_URL", "http://127.0.0.1:9225"),
        ("INSTAFY_ENABLE_BROWSER_SESSION", "1"),
        ("INSTAFY_VNC_GEOMETRY", "1280x720"),
        ("INSTAFY_VNC_PORT", "5900"),
        (
            "ORIGIN_GIT_REMOTE_URL",
            "https://git.example.test/space.git",
        ),
        ("RUNTIME_CPU_LIMIT", "2"),
        ("RUNTIME_MEMORY_LIMIT", "4g"),
    ];

    /// Variables that `docker compose`, the processes it runs or the runtime compose files read
    /// for themselves, with a value each that would point them elsewhere. A launch request sets
    /// none of them, for any provider.
    const DOCKER_AND_HOST_SETTINGS: &[(&str, &str)] = &[
        // The Docker CLI, Compose and BuildKit.
        ("DOCKER_HOST", "tcp://elsewhere.test:2375"),
        ("DOCKER_CONTEXT", "elsewhere"),
        ("DOCKER_CONFIG", "/tmp/elsewhere-docker-config"),
        ("DOCKER_CERT_PATH", "/tmp/elsewhere-certs"),
        ("DOCKER_TLS_VERIFY", "0"),
        ("COMPOSE_FILE", "/tmp/elsewhere-compose.yml"),
        ("COMPOSE_PROJECT_NAME", "elsewhere"),
        ("COMPOSE_PROFILES", "elsewhere"),
        ("COMPOSE_ENV_FILES", "/tmp/elsewhere.env"),
        ("BUILDKIT_HOST", "tcp://elsewhere.test:1234"),
        ("BUILDX_BUILDER", "elsewhere"),
        // The process itself: loader, shell, proxies, TLS, Go and git.
        ("PATH", "/tmp/elsewhere-bin"),
        ("HOME", "/tmp/elsewhere-home"),
        ("TMPDIR", "/tmp/elsewhere-tmp"),
        ("XDG_CONFIG_HOME", "/tmp/elsewhere-config"),
        ("LD_PRELOAD", "/tmp/elsewhere.so"),
        ("LD_LIBRARY_PATH", "/tmp/elsewhere-lib"),
        ("DYLD_INSERT_LIBRARIES", "/tmp/elsewhere.dylib"),
        ("BASH_ENV", "/tmp/elsewhere-shell-init"),
        ("HTTP_PROXY", "http://elsewhere.test:8080"),
        ("HTTPS_PROXY", "http://elsewhere.test:8443"),
        ("ALL_PROXY", "socks5://elsewhere.test:1080"),
        ("NO_PROXY", "*"),
        ("http_proxy", "http://elsewhere.test:8080"),
        ("SSL_CERT_FILE", "/tmp/elsewhere-ca.pem"),
        ("GODEBUG", "x509ignoreCN=1"),
        ("GIT_DIR", "/tmp/elsewhere-repo/.git"),
        ("GIT_CONFIG_GLOBAL", "/tmp/elsewhere-gitconfig"),
        ("GIT_SSH_COMMAND", "/tmp/elsewhere-ssh"),
        // What the runtime compose files interpolate outside the runtime's environment.
        ("RUNTIME_REPO_HOST", "/"),
        ("RUNTIME_CACHE_HOST", "/var/run"),
        ("RUNTIME_CODEX_VOLUME", "/root"),
        ("PROXY_CODEX_VOLUME", "/etc"),
        ("INSTAFY_ENV_DIR", "/tmp/elsewhere-env"),
        (
            "PROXY_CREDENTIAL_LEASE_ENV_FILE",
            "/tmp/elsewhere-lease.env",
        ),
        ("RUNTIME_PROXY_IMAGE", "elsewhere/proxy:latest"),
        ("PROXY_CONTROLLER_BASE_URL", "https://elsewhere.test"),
        ("CONTROLLER_BASE_URL", "https://elsewhere.test"),
        ("CONTROLLER_INTERNAL_TOKEN", "elsewhere"),
        ("PROXY_SIGNING_SECRET", "elsewhere"),
        ("OPENAI_API_KEY", "elsewhere"),
        ("ORIGIN_GIT_AUTHOR_NAME", "elsewhere"),
        ("ORIGIN_HOST_PORT", "22"),
        ("PROXY_PORT", "22"),
        // What picks the image, or once asked the allocator to build one.
        ("RUNTIME_AGENT_IMAGE", "elsewhere/runtime:latest"),
        ("RUNTIME_AGENT_BUILD_TARGET", "elsewhere"),
        ("RUNTIME_AGENT_FORCE_BUILD", "1"),
        // Read inside a runtime, but no runtime compose file passes it on.
        (
            "INSTAFY_SHARED_BROWSER_APPROVAL_DIR",
            "/tmp/elsewhere-approvals",
        ),
    ];

    /// Provider ids the allocator treats as other than exact instafy_cloud.
    const CUSTOM_PROVIDERS: &[&str] = &[
        "hosted",
        "external-http",
        "self-hosted",
        "instafy-cloud-custom",
        "instafy_cloud_eu",
    ];

    /// A provider config whose checkouts, codex volumes and caches land in `scratch`.
    fn scratch_config(scratch: &ScratchDir) -> ProviderConfig {
        let mut config = ProviderConfig::default_docker();
        config.runtime_agent_image = Some("runtime-agent:provider".to_string());
        config.runtime_docker_repo_host = Some(scratch.0.join("repos"));
        config.runtime_docker_codex_root = Some(scratch.0.join("codex"));
        config
    }

    /// An allocator on [`scratch_config`] with no controller on its node.
    fn scratch_allocator(scratch: &ScratchDir, from_request: bool) -> DockerRuntimeAllocator {
        let mut config = scratch_config(scratch);
        config.runtime_agent_image_from_request = from_request;
        let mut allocator = DockerRuntimeAllocator::new(&config).expect("allocator");
        allocator.controller_base_url = None;
        allocator
    }

    /// A directory under the temp dir that is removed when the test ends, passed or failed.
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new(label: &str) -> Self {
            Self(std::env::temp_dir().join(format!("{label}-{}", Uuid::new_v4())))
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
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
        let scratch = ScratchDir::new("instafy-provider-image");
        let mut config = scratch_config(&scratch);
        config.runtime_agent_image =
            Some("ghcr.io/instafy-dev/instafy-runtime-agent:release".to_string());
        let allocator = DockerRuntimeAllocator::new(&config).expect("allocator");
        let envs = launch_env(&allocator, &sample_request(None));

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
    fn build_env_keeps_what_the_provider_and_its_operator_set() {
        let scratch = ScratchDir::new("instafy-provider-keeps");
        let mut allocator = scratch_allocator(&scratch, false);
        allocator.controller_base_url = Some("http://controller.internal:8788".to_string());
        let envs = launch_env(
            &allocator,
            &sample_request(Some(json!({
                "env": {
                    "PROXY_UPSTREAM_CHATGPT_ENDPOINT": "https://elsewhere.test/backend-api/codex/responses",
                    "PROXY_UPSTREAM_OPENAI_ENDPOINT": "https://elsewhere.test/v1",
                    "CONTROLLER_BASE_URL": "https://elsewhere.test",
                    "RUNTIME_ACCESS_TOKEN": "chosen",
                    "ORIGIN_INTERNAL_TOKEN": "chosen",
                    "RUNTIME_ID": "chosen",
                    "SPACE_ID": "chosen",
                    "CODEX_MODEL": "chosen-model"
                }
            }))),
        );

        for key in [
            "PROXY_UPSTREAM_CHATGPT_ENDPOINT",
            "PROXY_UPSTREAM_OPENAI_ENDPOINT",
        ] {
            assert_eq!(env_value(&envs, key), None, "{key}");
        }
        for key in [
            "CONTROLLER_BASE_URL",
            "RUNTIME_ACCESS_TOKEN",
            "ORIGIN_INTERNAL_TOKEN",
            "RUNTIME_ID",
            "SPACE_ID",
        ] {
            assert_eq!(
                envs.iter().filter(|(name, _)| name == key).count(),
                1,
                "{key} is set once, by the provider"
            );
            assert_ne!(env_value(&envs, key), Some("chosen"), "{key}");
        }
        assert_eq!(
            env_value(&envs, "CONTROLLER_BASE_URL"),
            Some("http://controller.internal:8788")
        );
        // The model is the operator's to set, in the provider service's own environment.
        assert_eq!(env_value(&envs, "CODEX_MODEL"), None);
    }

    /// For a provider other than exact instafy_cloud, the request's top-level
    /// `metadata.runtimeAgentImage` picks the image only where the operator lets requests choose
    /// it; `metadata.env` never does.
    #[test]
    fn a_request_picks_the_image_only_where_the_operator_allows_it() {
        let scratch = ScratchDir::new("instafy-runtime-image");
        let chosen = json!({
            "runtimeAgentImage": "ghcr.io/instafy-dev/instafy-runtime-agent:request",
            "env": {
                "RUNTIME_AGENT_IMAGE": "ghcr.io/instafy-dev/instafy-runtime-agent:env"
            }
        });
        let env_only = json!({
            "env": {
                "RUNTIME_AGENT_IMAGE": "ghcr.io/instafy-dev/instafy-runtime-agent:env"
            }
        });
        for (from_request, provider, metadata, expected) in [
            (
                true,
                "hosted",
                &chosen,
                "ghcr.io/instafy-dev/instafy-runtime-agent:request",
            ),
            (false, "hosted", &chosen, "runtime-agent:provider"),
            (true, "hosted", &env_only, "runtime-agent:provider"),
            (false, "hosted", &env_only, "runtime-agent:provider"),
            (true, "instafy-cloud", &chosen, "runtime-agent:provider"),
        ] {
            let allocator = scratch_allocator(&scratch, from_request);
            let mut request = sample_request(Some(metadata.clone()));
            request.provider = provider.to_string();
            let envs = launch_env(&allocator, &request);
            assert_eq!(
                env_value(&envs, "RUNTIME_AGENT_IMAGE"),
                Some(expected),
                "{provider}, from request {from_request}: {metadata}"
            );
        }

        // A reference Docker would read as an option, or one that holds a control character,
        // picks nothing.
        for value in [
            "--privileged",
            "-v/:/host",
            "runtime-agent:\u{0}request",
            "runtime-agent:\u{1b}request",
            "runtime-agent:\u{9b}request",
        ] {
            assert_eq!(
                resolve_runtime_agent_image(&json!({ "runtimeAgentImage": value })),
                None,
                "{value:?}"
            );
        }
    }

    /// `docker compose` runs with the environment build_env returns, and the Docker CLI,
    /// Compose, BuildKit and the dynamic loader read their own settings from it, while the
    /// runtime compose files turn other variables into host paths, images, ports and the proxy
    /// sidecar. A request's metadata.env, for any provider, changes none of that apart from the
    /// CPU and memory limits the controller sets from the runtime's size; it changes only what
    /// the runtime container receives. The image comes from the provider or, where its operator
    /// allows it, the request's top-level metadata, never from metadata.env.
    #[test]
    fn a_request_changes_only_what_reaches_the_runtime_container() {
        // The checkouts, codex volumes and caches the allocator and build_env create all land
        // in here.
        let scratch = ScratchDir::new("instafy-request-env");
        let repo_base = scratch.0.join("repos");
        let mut config = ProviderConfig::default_docker();
        config.runtime_agent_image = Some("runtime-agent:provider".to_string());
        config.runtime_docker_repo_host = Some(repo_base.clone());
        config.runtime_docker_codex_root = Some(scratch.0.join("codex"));
        let mut allocator = DockerRuntimeAllocator::new(&config).expect("allocator");
        allocator.controller_base_url = None;

        let docker_and_host_settings: serde_json::Map<String, JsonValue> = DOCKER_AND_HOST_SETTINGS
            .iter()
            .map(|(key, value)| (key.to_string(), JsonValue::String(value.to_string())))
            .collect();
        let without_metadata = |envs: Vec<(String, String)>| {
            envs.into_iter()
                .filter(|(key, _)| key != "RUNTIME_METADATA")
                .collect::<Vec<_>>()
        };
        for provider in [
            "hosted",
            "external-http",
            "instafy-cloud-custom",
            "self-hosted",
            "instafy-cloud",
        ] {
            let mut request = sample_request(Some(json!({ "env": {} })));
            request.provider = provider.to_string();
            let unset = launch_env(&allocator, &request);
            request.metadata = Some(json!({ "env": docker_and_host_settings }));
            let requested = launch_env(&allocator, &request);
            assert_eq!(
                without_metadata(requested),
                without_metadata(unset),
                "{provider}"
            );
        }

        let mut request = sample_request(Some(json!({
            "env": {
                "CODEX_MODEL": "chosen-model",
                "ORIGIN_GIT_REMOTE_URL": "https://git.example.test/space.git",
                "INSTAFY_ENABLE_BROWSER_SESSION": true,
                "RUNTIME_CPU_LIMIT": "2",
                "RUNTIME_MEMORY_LIMIT": "4g",
            }
        })));
        request.provider = "external-http".to_string();
        let envs = launch_env(&allocator, &request);
        assert_eq!(env_value(&envs, "CODEX_MODEL"), None);
        assert_eq!(
            env_value(&envs, "ORIGIN_GIT_REMOTE_URL"),
            Some("https://git.example.test/space.git")
        );
        assert_eq!(
            env_value(&envs, "INSTAFY_ENABLE_BROWSER_SESSION"),
            Some("1")
        );
        assert_eq!(env_value(&envs, "RUNTIME_CPU_LIMIT"), Some("2"));
        assert_eq!(env_value(&envs, "RUNTIME_MEMORY_LIMIT"), Some("4g"));
        assert_eq!(
            env_value(&envs, "RUNTIME_REPO_HOST"),
            Some(
                repo_base
                    .join(request.project_id.to_string())
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[test]
    fn the_runtime_variable_lists_hold_together() {
        // What only a custom provider's operator sets of the managed launch keys, written out:
        // a change to it is a change to who decides the Shared Browser's egress and display.
        assert_eq!(
            EXACT_ONLY_LAUNCH_ENV_KEYS,
            [
                "INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS",
                "INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV",
                "INSTAFY_BROWSER_EGRESS_ISOLATION",
                "INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS",
                "INSTAFY_BROWSER_EGRESS_PROXY_BIND",
                "INSTAFY_VNC_DEPTH",
                "INSTAFY_VNC_HOST",
            ]
        );
        for (name, list) in [
            ("EXACT_ONLY_LAUNCH_ENV_KEYS", EXACT_ONLY_LAUNCH_ENV_KEYS),
            (
                "OPERATOR_ONLY_RUNTIME_ENV_KEYS",
                OPERATOR_ONLY_RUNTIME_ENV_KEYS,
            ),
            (
                "REQUEST_DERIVED_RUNTIME_ENV_KEYS",
                REQUEST_DERIVED_RUNTIME_ENV_KEYS,
            ),
        ] {
            assert!(
                list.windows(2).all(|pair| pair[0] < pair[1]),
                "keep {name} sorted and unique"
            );
        }
        for key in EXACT_ONLY_LAUNCH_ENV_KEYS {
            assert!(is_allowed_managed_runtime_env_key(key), "{key}");
        }
        for key in OPERATOR_ONLY_RUNTIME_ENV_KEYS
            .iter()
            .chain(REQUEST_DERIVED_RUNTIME_ENV_KEYS)
        {
            assert!(!is_allowed_managed_runtime_env_key(key), "{key}");
        }
        for key in REQUEST_DERIVED_RUNTIME_ENV_KEYS {
            assert!(!OPERATOR_ONLY_RUNTIME_ENV_KEYS.contains(key), "{key}");
        }
        for (key, _) in CUSTOM_LAUNCH_ENV {
            assert!(is_allowed_managed_runtime_env_key(key), "{key}");
            assert!(!EXACT_ONLY_LAUNCH_ENV_KEYS.contains(key), "{key}");
        }
    }

    /// For a provider other than exact instafy_cloud a launch request sets the managed launch
    /// keys but the operator's browser policy, and nothing else: not the runtime's model routing,
    /// sandbox, timings, capabilities or credentials, nor what build_env derives from the
    /// request's own fields, whatever the value's type. For exact instafy_cloud the operator's
    /// browser policy comes through the controller, which strips a client's value first. What the
    /// provider service's own environment sets still reaches Compose, which inherits it.
    #[test]
    fn a_launch_sets_only_the_launch_keys_its_provider_takes() {
        let scratch = ScratchDir::new("instafy-launch-keys");
        let allocator = scratch_allocator(&scratch, false);
        for provider in CUSTOM_PROVIDERS.iter().chain(&["instafy-cloud"]) {
            let exact = is_exact_managed_provider(provider);
            let mut request = sample_request(Some(json!({ "env": {} })));
            request.provider = provider.to_string();
            let unset = launch_env(&allocator, &request);
            for value in [
                json!("chosen"),
                json!(7),
                json!(true),
                json!(["chosen"]),
                json!({ "chosen": true }),
            ] {
                let refused: serde_json::Map<String, JsonValue> = OPERATOR_ONLY_RUNTIME_ENV_KEYS
                    .iter()
                    .chain(REQUEST_DERIVED_RUNTIME_ENV_KEYS)
                    .chain(if exact {
                        &[][..]
                    } else {
                        EXACT_ONLY_LAUNCH_ENV_KEYS
                    })
                    .map(|key| (key.to_string(), value.clone()))
                    .collect();
                request.metadata = Some(json!({ "env": refused }));
                let requested = launch_env(&allocator, &request);
                assert_eq!(requested, unset, "{provider} with {value}");
            }

            let launch: serde_json::Map<String, JsonValue> = CUSTOM_LAUNCH_ENV
                .iter()
                .map(|(key, value)| (key.to_string(), json!(value)))
                .collect();
            request.metadata = Some(json!({ "env": launch }));
            let envs = launch_env(&allocator, &request);
            for (key, value) in CUSTOM_LAUNCH_ENV {
                assert_eq!(env_value(&envs, key), Some(*value), "{provider}: {key}");
            }
            let metadata: JsonValue =
                serde_json::from_str(env_value(&envs, "RUNTIME_METADATA").expect("metadata"))
                    .expect("metadata JSON");
            assert_eq!(metadata["env"], json!(launch), "{provider}");

            // The WebRTC switch: the controller's relay policy applies to the string "1" alone,
            // so a provider other than exact instafy_cloud takes only a string; exact
            // instafy_cloud's controller has already put every value in that form.
            for (value, on_exact, on_custom) in [
                (json!("1"), Some("1"), Some("1")),
                (json!("0"), Some("0"), Some("0")),
                (json!(true), Some("1"), None),
                (json!(false), Some("0"), None),
                (json!(1), Some("1"), None),
                (json!(1.0), Some("1.0"), None),
                (json!(0), Some("0"), None),
                (json!(["1"]), None, None),
                (json!({ "enabled": "1" }), None, None),
            ] {
                request.metadata =
                    Some(json!({ "env": { "INSTAFY_BROWSER_WEBRTC_ENABLED": value } }));
                let envs = launch_env(&allocator, &request);
                assert_eq!(
                    env_value(&envs, "INSTAFY_BROWSER_WEBRTC_ENABLED"),
                    if exact { on_exact } else { on_custom },
                    "{provider}: {value}"
                );
            }
        }
    }

    /// A request value reaches the runtime on one line or not at all, and the Shared Browser's
    /// display is a local one, for every provider.
    #[test]
    fn a_request_value_is_one_line_and_a_display_is_local() {
        let scratch = ScratchDir::new("instafy-request-values");
        let allocator = scratch_allocator(&scratch, false);
        for provider in ["hosted", "instafy-cloud"] {
            let launch = |env: JsonValue| {
                let mut request = sample_request(Some(json!({ "env": env })));
                request.provider = provider.to_string();
                let envs = launch_env(&allocator, &request);
                for (name, value) in &envs {
                    assert!(!value.chars().any(breaks_env_line), "{provider}: {name}");
                }
                envs
            };
            for value in [
                format!("1280x720\nRUNTIME_LEASE_ID={}", Uuid::new_v4()),
                "1280x720\r".to_string(),
                "1280\u{0}x720".to_string(),
                "1280\u{7f}x720".to_string(),
                "1280\u{85}x720".to_string(),
                "1280\u{2028}x720".to_string(),
                "1280\u{2029}x720".to_string(),
            ] {
                let envs = launch(json!({ "INSTAFY_VNC_GEOMETRY": value }));
                assert_eq!(env_value(&envs, "INSTAFY_VNC_GEOMETRY"), None, "{value:?}");
                let metadata = env_value(&envs, "RUNTIME_METADATA").expect("metadata");
                assert!(!metadata.contains("INSTAFY_VNC_GEOMETRY"), "{value:?}");
            }

            // A JSON list laid out over several lines arrives on one.
            let envs = launch(json!({
                "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON":
                    "[\n  {\"urls\": [\"stun:stun.example.test:19302\"], \"note\": \"a\u{2028}b\"}\n]"
            }));
            let ice = env_value(&envs, "INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON").expect("ice");
            assert_eq!(
                ice,
                r#"[{"note":"a\u2028b","urls":["stun:stun.example.test:19302"]}]"#
            );
            assert_eq!(
                serde_json::from_str::<JsonValue>(ice).unwrap(),
                json!([{ "urls": ["stun:stun.example.test:19302"], "note": "a\u{2028}b" }])
            );

            for (display, accepted) in [
                (":0", true),
                (":1", true),
                (":47", true),
                (":9999", true),
                (":01", false),
                (":10000", false),
                (":", false),
                ("1", false),
                (":1.0", false),
                (": 1", false),
                ("host:0", false),
                ("display.example.test:0", false),
            ] {
                let envs = launch(json!({ "INSTAFY_BROWSER_DISPLAY": display }));
                assert_eq!(
                    env_value(&envs, "INSTAFY_BROWSER_DISPLAY"),
                    accepted.then_some(display),
                    "{provider}: {display}"
                );
            }
        }

        // A provider other than exact instafy_cloud takes an array or object value as JSON, on
        // one line.
        let mut request = sample_request(Some(json!({
            "env": { "INSTAFY_VNC_GEOMETRY": { "note": "a\nb\u{2029}c" } }
        })));
        request.provider = "hosted".to_string();
        let envs = launch_env(&allocator, &request);
        assert_eq!(
            env_value(&envs, "INSTAFY_VNC_GEOMETRY"),
            Some(r#"{"note":"a\nb\u2029c"}"#)
        );
    }

    /// The origin fields of a request reach the runtime as the runtime reads them, or not at all.
    #[test]
    fn a_request_names_its_origin_only_as_the_runtime_reads_it() {
        let scratch = ScratchDir::new("instafy-request-origin");
        let allocator = scratch_allocator(&scratch, false);
        for provider in ["hosted", "instafy-cloud"] {
            let mut request = sample_request(None);
            request.provider = provider.to_string();
            for (mode, expected) in [
                ("hosted", Some("hosted")),
                (" Desktop ", Some("desktop")),
                ("EFS", Some("efs")),
                ("bogus", None),
                ("hosted\nRUNTIME_LEASE_ID=x", None),
                ("", None),
            ] {
                request.origin_mode = Some(mode.to_string());
                let envs = launch_env(&allocator, &request);
                assert_eq!(env_value(&envs, "ORIGIN_MODE"), expected, "{mode:?}");
            }
            request.origin_mode = None;

            request.origin_protocols = ["http", "ws", "http,ws", "HTTP", "", "a\nb", "x+y.z-1"]
                .into_iter()
                .map(String::from)
                .chain(["p".repeat(33)])
                .collect();
            request.origin_metadata = Some(json!({ "note": "a\nb\u{2028}c\u{85}d" }));
            let envs = launch_env(&allocator, &request);
            assert_eq!(
                env_value(&envs, "ORIGIN_PROTOCOLS"),
                Some("http,ws,x+y.z-1")
            );
            let origin_metadata = env_value(&envs, "ORIGIN_METADATA").expect("origin metadata");
            assert!(!origin_metadata.chars().any(breaks_env_line));
            assert_eq!(
                serde_json::from_str::<JsonValue>(origin_metadata).unwrap(),
                json!({ "note": "a\nb\u{2028}c\u{85}d" })
            );

            request.origin_protocols = vec!["a,b".to_string()];
            let envs = launch_env(&allocator, &request);
            assert_eq!(env_value(&envs, "ORIGIN_PROTOCOLS"), None);
        }
    }

    /// Whatever a launch request chooses reaches only a managed launch key, one of
    /// REQUEST_DERIVED_RUNTIME_ENV_KEYS, or the image of a provider whose operator lets requests
    /// choose it; and each of REQUEST_DERIVED_RUNTIME_ENV_KEYS is set from the request.
    #[test]
    fn what_a_request_chooses_reaches_only_its_own_variables() {
        const MARK: &str = "requestchoice";
        let scratch = ScratchDir::new("instafy-request-mark");
        let mut env = serde_json::Map::new();
        for key in OPERATOR_ONLY_RUNTIME_ENV_KEYS
            .iter()
            .chain(REQUEST_DERIVED_RUNTIME_ENV_KEYS)
            .chain(EXACT_ONLY_LAUNCH_ENV_KEYS)
            .chain(CUSTOM_LAUNCH_ENV.iter().map(|(key, _)| key))
            .chain(DOCKER_AND_HOST_SETTINGS.iter().map(|(key, _)| key))
            .chain(&[
                "PROXY_UPSTREAM_OPENAI_ENDPOINT",
                "RUNTIME_PROVIDER",
                "SPACE_ID",
                // Names that only look like a launch key.
                "INSTAFY_ANYTHING",
                "ORIGIN_ANYTHING",
                "RUNTIME_ANYTHING",
                "instafy_vnc_port",
                "Instafy_Browser_Egress_Isolation",
                " INSTAFY_VNC_PORT",
                "INSTAFY_VNC_PORT ",
                "INSTAFY_VNC_PORT=1",
            ])
        {
            env.insert(key.to_string(), json!(format!("{MARK}-{key}")));
        }
        // A value the display check keeps.
        env.insert("INSTAFY_BROWSER_DISPLAY".to_string(), json!(":1"));
        for from_request in [false, true] {
            let allocator = scratch_allocator(&scratch, from_request);
            for provider in CUSTOM_PROVIDERS.iter().chain(&["instafy-cloud"]) {
                let mut request = sample_request(Some(json!({
                    "runtimeAgentImage": format!("registry.example.test/{MARK}:tag"),
                    "runtime_agent_image": format!("registry.example.test/{MARK}:other"),
                    "note": MARK,
                    "env": env,
                })));
                request.provider = provider.to_string();
                request.origin_mode = Some("hosted".to_string());
                request.origin_protocols = vec![MARK.to_string()];
                request.origin_metadata = Some(json!({ "note": MARK }));
                let envs = launch_env(&allocator, &request);
                for (name, value) in &envs {
                    if value.contains(MARK) {
                        assert!(
                            is_allowed_managed_runtime_env_key(name)
                                || REQUEST_DERIVED_RUNTIME_ENV_KEYS.contains(&name.as_str())
                                || (name == "RUNTIME_AGENT_IMAGE"
                                    && from_request
                                    && !is_exact_managed_provider(provider)),
                            "{provider}: {name} carries what the request chose"
                        );
                    }
                }
                for key in REQUEST_DERIVED_RUNTIME_ENV_KEYS {
                    assert!(env_value(&envs, key).is_some(), "{provider}: {key}");
                }

                // Without the request's own fields, none of them is set.
                request.metadata = None;
                request.origin_mode = None;
                request.origin_protocols = Vec::new();
                request.origin_metadata = None;
                let envs = launch_env(&allocator, &request);
                for key in REQUEST_DERIVED_RUNTIME_ENV_KEYS {
                    assert_eq!(env_value(&envs, key), None, "{provider}: {key}");
                }
            }
        }
    }

    /// The runtime's copy of its launch metadata (RUNTIME_METADATA) keeps the request's other
    /// fields as they came, holds as its env only what the request set here, and reaches the
    /// runtime on one line, for every provider.
    #[test]
    fn the_runtime_metadata_holds_only_what_the_request_set() {
        let scratch = ScratchDir::new("instafy-runtime-metadata");
        let allocator = scratch_allocator(&scratch, false);
        let note = "a\u{85}b\u{2028}c\u{9b}d\ne\u{7f}f\u{2029}g";
        let read = |envs: &[(String, String)]| -> JsonValue {
            let raw = env_value(envs, "RUNTIME_METADATA").expect("metadata");
            assert!(!raw.chars().any(breaks_env_line), "{raw:?}");
            serde_json::from_str(raw).expect("metadata JSON")
        };
        for provider in ["hosted", "instafy-cloud"] {
            let mut request = sample_request(Some(json!({
                "note": note,
                "nested": { "list": [1, "two", { "three": note }] },
                "env": {
                    "INSTAFY_VNC_GEOMETRY": "1280x720",
                    "INSTAFY_ENABLE_BROWSER_SESSION": true,
                    "INSTAFY_VNC_PORT": null,
                    "INSTAFY_BROWSER_RENDER_SCALE": "",
                    "INSTAFY_BROWSER_DISPLAY": "display.example.test:0",
                    "CODEX_MODEL": "chosen-model",
                    "RUNTIME_METADATA": "chosen",
                    "PATH": "/tmp/elsewhere-bin",
                },
            })));
            request.provider = provider.to_string();
            let metadata = read(&launch_env(&allocator, &request));
            assert_eq!(metadata["note"], note, "{provider}");
            assert_eq!(
                metadata["nested"],
                json!({ "list": [1, "two", { "three": note }] }),
                "{provider}"
            );
            assert_eq!(
                metadata["env"],
                json!({
                    "INSTAFY_ENABLE_BROWSER_SESSION": "1",
                    "INSTAFY_VNC_GEOMETRY": "1280x720",
                }),
                "{provider}"
            );

            // An env that is no object sets nothing and is left out, and metadata without one
            // gets none.
            for env in [
                json!("INSTAFY_VNC_GEOMETRY=1280x720"),
                json!(["INSTAFY_VNC_GEOMETRY"]),
                JsonValue::Null,
            ] {
                request.metadata = Some(json!({ "note": "kept", "env": env }));
                let envs = launch_env(&allocator, &request);
                assert_eq!(env_value(&envs, "INSTAFY_VNC_GEOMETRY"), None);
                assert_eq!(read(&envs), json!({ "note": "kept" }), "{provider}: {env}");
            }
            request.metadata = Some(json!({ "note": "kept" }));
            assert_eq!(
                read(&launch_env(&allocator, &request)),
                json!({ "note": "kept" }),
                "{provider}"
            );
        }
    }

    #[test]
    fn managed_webdev_uses_provider_pinned_image_and_ignores_spoofed_env() {
        let scratch = ScratchDir::new("instafy-webdev-image");
        let mut config = scratch_config(&scratch);
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

        let envs = launch_env(&allocator, &request);
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
        let scratch = ScratchDir::new("instafy-webdev-generation");
        let mut config = scratch_config(&scratch);
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
        let scratch = ScratchDir::new("instafy-exact-image");
        for from_request in [false, true] {
            let mut config = scratch_config(&scratch);
            config.runtime_agent_image = Some("runtime-agent:base-sha".to_string());
            config.runtime_agent_image_from_request = from_request;
            let allocator = DockerRuntimeAllocator::new(&config).expect("allocator");
            let mut request = sample_request(Some(json!({
                "runtimeAgentImage": "attacker/image:direct",
                "env": {
                    "RUNTIME_AGENT_IMAGE": "attacker/image:env",
                    "RUNTIME_CAPABILITIES": "{\"spoofed\":true}",
                }
            })));
            request.provider = "instafy-cloud".to_string();

            let envs = launch_env(&allocator, &request);
            assert_eq!(
                env_value(&envs, "RUNTIME_AGENT_IMAGE"),
                Some("runtime-agent:base-sha")
            );
            assert_eq!(env_value(&envs, "RUNTIME_CAPABILITIES"), None);
        }
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

    /// A start that ran out of address pools frees the runtime networks no
    /// space needs before its one retry; any other failure frees nothing.
    #[test]
    fn only_an_address_pool_exhaustion_reclaims_before_the_retry() {
        use super::super::address_pools::tests::{runtime_project, FakeDocker};
        let prefix = "instafy-runtime-";
        let starting = runtime_project(prefix, Uuid::new_v4());
        let leftover = runtime_project(prefix, Uuid::new_v4());
        let docker = FakeDocker::default();
        *docker.networks.lock().unwrap() = vec![
            format!("{leftover}_default"),
            "instafy-runtime_default".to_string(),
        ];

        let other = reclaim_after_failed_start(
            &docker,
            prefix,
            &starting,
            &NoSpaceDirectory,
            "exit=1 stderr=\"Bind for 0.0.0.0:55990 failed: port is already allocated\"",
        );
        assert_eq!(other, None);
        assert!(docker.calls.lock().unwrap().is_empty());

        let reclaimed = reclaim_after_failed_start(
            &docker,
            prefix,
            &starting,
            &NoSpaceDirectory,
            &format!(
                "exit=1 stderr=\"failed to create network {starting}_default: Error response from daemon: all predefined address pools have been fully subnetted\""
            ),
        )
        .expect("reclaimed");
        assert_eq!(reclaimed.networks, vec![format!("{leftover}_default")]);
        assert_eq!(
            docker.networks.lock().unwrap().clone(),
            vec!["instafy-runtime_default".to_string()]
        );
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
