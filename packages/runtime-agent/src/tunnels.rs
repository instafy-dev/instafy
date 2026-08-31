use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration as StdDuration;

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::{Map as JsonMap, Value as JsonValue, json};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::{debug, info, warn};
use uuid::Uuid;

use origin_http_server::config::SharedControllerToken;

use crate::config::{Config, OriginSettings};
use crate::controller::Registration;
use crate::model_environment::apply_allowlisted_tokio_environment;
use crate::origin::OriginTunnelSnapshot;

#[derive(Debug, Clone)]
pub struct TunnelAssignment {
    pub provider: String,
    pub tunnel_id: String,
    pub hostname: String,
    pub url: String,
    pub status: String,
    pub expires_at: DateTime<Utc>,
    pub credentials: JsonValue,
    pub metadata: Option<JsonValue>,
    pub last_rotation_at: DateTime<Utc>,
}

impl TunnelAssignment {
    pub fn snapshot(&self) -> OriginTunnelSnapshot {
        OriginTunnelSnapshot {
            provider: self.provider.clone(),
            hostname: self.hostname.clone(),
            url: self.url.clone(),
            tunnel_id: self.tunnel_id.clone(),
            status: Some(self.status.clone()),
            expires_at: Some(self.expires_at),
            last_rotation_at: self.last_rotation_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControllerTunnelGrant {
    #[allow(dead_code)]
    id: String,
    #[allow(dead_code)]
    project_id: String,
    #[allow(dead_code)]
    runtime_id: Option<String>,
    #[allow(dead_code)]
    runtime_lease_id: Option<String>,
    provider: String,
    tunnel_id: String,
    hostname: String,
    url: String,
    status: String,
    expires_at: String,
    metadata: Option<JsonValue>,
    #[serde(default)]
    credentials: Option<JsonValue>,
}

impl TryFrom<ControllerTunnelGrant> for TunnelAssignment {
    type Error = anyhow::Error;

    fn try_from(value: ControllerTunnelGrant) -> Result<Self> {
        let expires_at = DateTime::parse_from_rfc3339(&value.expires_at)
            .context("failed to parse tunnel expiresAt timestamp")?
            .with_timezone(&Utc);
        let credentials = value
            .credentials
            .ok_or_else(|| anyhow!("controller tunnel response missing credentials payload"))?;

        Ok(Self {
            provider: value.provider,
            tunnel_id: value.tunnel_id,
            hostname: value.hostname,
            url: value.url,
            status: value.status,
            expires_at,
            metadata: value.metadata,
            credentials,
            last_rotation_at: Utc::now(),
        })
    }
}

fn tunnel_request_body(
    runtime_id: Uuid,
    runtime_lease_id: Option<Uuid>,
    metadata: JsonMap<String, JsonValue>,
) -> JsonValue {
    let mut body = JsonMap::new();
    body.insert("runtimeId".to_string(), json!(runtime_id));
    if let Some(runtime_lease_id) = runtime_lease_id {
        body.insert("runtimeLeaseId".to_string(), json!(runtime_lease_id));
    }
    body.insert("metadata".to_string(), JsonValue::Object(metadata));
    JsonValue::Object(body)
}

pub async fn request_tunnel_assignment(
    config: &Config,
    registration: &Registration,
) -> Result<Option<TunnelAssignment>> {
    let origin_settings = match config.origin.as_ref() {
        Some(settings) => settings,
        None => {
            debug!("origin disabled; skipping tunnel assignment request");
            return Ok(None);
        }
    };
    if !origin_settings.tunnel_enabled {
        debug!(
            mode = %origin_settings.mode,
            "origin tunnel disabled; skipping tunnel assignment request"
        );
        return Ok(None);
    }

    let internal_token = match registration
        .runtime_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .or_else(|| {
            origin_settings
                .controller_internal_token
                .as_deref()
                .map(str::trim)
                .filter(|token| !token.is_empty())
        }) {
        Some(token) => token,
        _ => {
            warn!("runtime access token missing; cannot request tunnel credentials");
            return Ok(None);
        }
    };

    let runtime_id = registration.runtime_id;
    // Private self-hosted runtimes intentionally do not use the hosted
    // allocator lease lifecycle. Their signed runtime generation and owner
    // attestation are the tunnel authority; provider-managed registrations
    // continue to carry an explicit lease and are rejected by the controller
    // if one is absent.
    let runtime_lease_id = registration.lease_id;

    let mut url = config.controller_base_url.clone();
    url.path_segments_mut()
        .map_err(|_| anyhow!("controller base URL is not valid for tunnel requests"))?
        .extend([
            "projects",
            &config.project_id.to_string(),
            "tunnels",
            "request",
        ]);

    let mut metadata = JsonMap::new();
    metadata.insert(
        "provider".to_string(),
        JsonValue::String(config.provider.clone()),
    );
    metadata.insert(
        "runtimeVersion".to_string(),
        JsonValue::String(config.runtime_version.clone()),
    );
    if let Some(name) = config.display_name.as_ref() {
        metadata.insert("displayName".to_string(), JsonValue::String(name.clone()));
    }

    let client = reqwest::Client::builder()
        .timeout(StdDuration::from_secs(60))
        .build()
        .context("failed to build tunnel request client")?;
    let response = client
        .post(url.clone())
        .bearer_auth(internal_token)
        .json(&tunnel_request_body(runtime_id, runtime_lease_id, metadata))
        .send()
        .await
        .context("failed to call tunnel request endpoint")?;

    match response.status() {
        StatusCode::SERVICE_UNAVAILABLE => {
            warn!("controller tunnel broker unavailable; tunnel request skipped");
            return Ok(None);
        }
        StatusCode::NOT_FOUND => {
            warn!(
                url = %url,
                "controller tunnel endpoint not found; skipping tunnel request"
            );
            return Ok(None);
        }
        _ => {}
    }

    let response = response
        .error_for_status()
        .context("controller rejected tunnel request")?;
    let payload: ControllerTunnelGrant = response
        .json()
        .await
        .context("failed to parse tunnel assignment response")?;

    let assignment = TunnelAssignment::try_from(payload)?;
    info!(
        tunnel_id = assignment.tunnel_id,
        hostname = assignment.hostname,
        "issued tunnel assignment"
    );

    Ok(Some(assignment))
}

pub struct TunnelLifecycle {
    assignment: Arc<Mutex<TunnelAssignment>>,
    status_emitter: Arc<TunnelStatusEmitter>,
    process: TunnelProcess,
    refresh_notify: Arc<Notify>,
    refresh_task: Option<JoinHandle<()>>,
    monitor_task: Option<JoinHandle<()>>,
    shutdown_flag: Arc<AtomicBool>,
}

impl TunnelLifecycle {
    pub async fn start(
        config: Arc<Config>,
        assignment: TunnelAssignment,
        presence_metadata: Option<Arc<RwLock<JsonValue>>>,
        token_source: Option<SharedControllerToken>,
    ) -> Result<Self> {
        let origin_settings = config
            .origin
            .as_ref()
            .ok_or_else(|| anyhow!("origin settings missing; cannot launch tunnel"))?;

        let provider = assignment.provider.trim().to_ascii_lowercase();
        if !matches!(
            provider.as_str(),
            "self_hosted" | "self-hosted" | "selfhosted"
        ) {
            return Err(anyhow!(
                "unsupported tunnel provider: {}",
                assignment.provider
            ));
        }
        let process =
            TunnelProcess::Rathole(RatholeProcess::spawn(origin_settings, &assignment).await?);
        let refresh_notify = Arc::new(Notify::new());
        let shutdown_flag = Arc::new(AtomicBool::new(false));
        let assignment_state = Arc::new(Mutex::new(assignment.clone()));
        let status_reporter = tunnel_status_reporter(&config, origin_settings, token_source);
        let status_emitter = Arc::new(TunnelStatusEmitter::new(
            assignment_state.clone(),
            presence_metadata,
            status_reporter,
        ));
        status_emitter.set_status("starting").await;

        spawn_ready_probe_task(
            assignment_state.clone(),
            status_emitter.clone(),
            shutdown_flag.clone(),
        );

        let refresh_task = spawn_refresh_task(
            assignment_state.clone(),
            assignment.expires_at,
            origin_settings.tunnel_refresh_margin,
            refresh_notify.clone(),
            status_emitter.clone(),
        );

        let monitor_task = spawn_monitor_task(
            process.child_handle(),
            refresh_notify.clone(),
            shutdown_flag.clone(),
            status_emitter.clone(),
        );

        Ok(Self {
            assignment: assignment_state,
            status_emitter,
            process,
            refresh_notify,
            refresh_task: Some(refresh_task),
            monitor_task: Some(monitor_task),
            shutdown_flag,
        })
    }

    pub fn refresh_notifier(&self) -> Arc<Notify> {
        self.refresh_notify.clone()
    }

    pub async fn shutdown(&mut self) {
        self.shutdown_flag.store(true, Ordering::SeqCst);
        self.refresh_notify.notify_waiters();
        let tunnel_id = {
            let assignment = self.assignment.lock().await;
            assignment.tunnel_id.clone()
        };
        info!(tunnel_id = tunnel_id, "shutting down tunnel lifecycle");
        self.status_emitter.mark_degraded().await;

        if let Err(error) = self.process.shutdown().await {
            warn!(?error, "failed to shutdown tunnel process cleanly");
        }

        if let Some(task) = self.refresh_task.take() {
            task.abort();
            if let Err(error) = task.await {
                if !error.is_cancelled() {
                    warn!(?error, "tunnel refresh task ended with error");
                }
            }
        }

        if let Some(task) = self.monitor_task.take() {
            task.abort();
            if let Err(error) = task.await {
                if !error.is_cancelled() {
                    warn!(?error, "tunnel monitor task ended with error");
                }
            }
        }
    }
}

fn spawn_ready_probe_task(
    assignment: Arc<Mutex<TunnelAssignment>>,
    status_emitter: Arc<TunnelStatusEmitter>,
    shutdown_flag: Arc<AtomicBool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(StdDuration::from_secs(2))
            .build();
        let Ok(client) = client else {
            status_emitter.mark_degraded().await;
            return;
        };

        let deadline = std::time::Instant::now() + StdDuration::from_secs(60);
        let mut attempt: u32 = 0;
        while std::time::Instant::now() < deadline && !shutdown_flag.load(Ordering::SeqCst) {
            attempt = attempt.saturating_add(1);
            let (tunnel_id, url) = {
                let guard = assignment.lock().await;
                (guard.tunnel_id.clone(), guard.url.clone())
            };
            let probe = match reqwest::Url::parse(&url) {
                Ok(mut parsed) => {
                    parsed.set_path("/healthz");
                    Some(parsed)
                }
                Err(_) => None,
            };
            let Some(probe_url) = probe else {
                status_emitter.mark_degraded().await;
                return;
            };

            match client.get(probe_url.clone()).send().await {
                Ok(resp) if resp.status().is_success() => {
                    status_emitter.mark_active().await;
                    info!(tunnel_id = tunnel_id, url = url, "tunnel is routable");
                    return;
                }
                Ok(resp) => {
                    debug!(
                        tunnel_id = tunnel_id,
                        status = %resp.status(),
                        attempt = attempt,
                        "tunnel probe failed"
                    );
                }
                Err(error) => {
                    debug!(
                        tunnel_id = tunnel_id,
                        ?error,
                        attempt = attempt,
                        "tunnel probe request failed"
                    );
                }
            }

            let sleep_ms = (200u64.saturating_mul(attempt.min(20) as u64)).min(2000);
            sleep(StdDuration::from_millis(sleep_ms)).await;
        }

        status_emitter.mark_degraded().await;
    })
}

fn spawn_refresh_task(
    assignment: Arc<Mutex<TunnelAssignment>>,
    expires_at: DateTime<Utc>,
    margin: StdDuration,
    notify: Arc<Notify>,
    status_emitter: Arc<TunnelStatusEmitter>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let now = Utc::now();
        let mut wait_duration = expires_at
            .signed_duration_since(now)
            .to_std()
            .unwrap_or_default();
        if wait_duration > margin {
            wait_duration -= margin;
        } else {
            wait_duration = StdDuration::from_secs(0);
        }
        if wait_duration.as_secs() > 0 {
            sleep(wait_duration).await;
        }
        status_emitter.mark_refreshing().await;
        {
            let mut guard = assignment.lock().await;
            guard.status = "refreshing".to_string();
        }
        notify.notify_waiters();
    })
}

fn spawn_monitor_task(
    child: Arc<Mutex<Child>>,
    notify: Arc<Notify>,
    shutdown_flag: Arc<AtomicBool>,
    status_emitter: Arc<TunnelStatusEmitter>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let exited = {
                let mut guard = child.lock().await;
                match guard.try_wait() {
                    Ok(Some(status)) => Some(status),
                    Ok(None) => None,
                    Err(error) => {
                        warn!(?error, "tunnel process try_wait failed");
                        None
                    }
                }
            };

            if let Some(status) = exited {
                if !shutdown_flag.load(Ordering::SeqCst) {
                    warn!(
                        ?status,
                        "tunnel process exited unexpectedly; requesting tunnel refresh"
                    );
                    status_emitter.mark_degraded().await;
                    notify.notify_waiters();
                }
                break;
            }

            sleep(StdDuration::from_secs(5)).await;
        }
    })
}

enum TunnelProcess {
    Rathole(RatholeProcess),
}

impl TunnelProcess {
    fn child_handle(&self) -> Arc<Mutex<Child>> {
        match self {
            TunnelProcess::Rathole(proc) => proc.child_handle(),
        }
    }

    async fn shutdown(&mut self) -> Result<()> {
        match self {
            TunnelProcess::Rathole(proc) => proc.shutdown().await,
        }
    }
}

struct RatholeProcess {
    tunnel_id: String,
    child: Arc<Mutex<Child>>,
    stdout_task: Option<JoinHandle<()>>,
    stderr_task: Option<JoinHandle<()>>,
    workdir: PathBuf,
    config_path: PathBuf,
}

impl RatholeProcess {
    async fn spawn(settings: &OriginSettings, assignment: &TunnelAssignment) -> Result<Self> {
        let workdir = settings.rathole_state_dir.join(&assignment.tunnel_id);
        fs::create_dir_all(&workdir)
            .await
            .with_context(|| format!("failed to create rathole workspace at {:?}", workdir))?;

        let config_path = workdir.join("client.toml");
        let config_body = build_rathole_config(settings, assignment)?;
        fs::write(&config_path, config_body.as_bytes())
            .await
            .with_context(|| format!("failed to write rathole config to {:?}", config_path))?;

        let mut command = Command::new(&settings.rathole_bin);
        if settings.rathole_use_subcommands {
            command.arg("client").arg("-c").arg(&config_path);
        } else {
            command.arg(&config_path);
        }
        apply_allowlisted_tokio_environment(&mut command, &[]);
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn rathole at {:?}", settings.rathole_bin))?;

        let stdout_task = child
            .stdout
            .take()
            .map(|pipe| spawn_log_task(pipe, assignment.tunnel_id.clone(), "rathole-stdout"));
        let stderr_task = child
            .stderr
            .take()
            .map(|pipe| spawn_log_task(pipe, assignment.tunnel_id.clone(), "rathole-stderr"));

        let child = Arc::new(Mutex::new(child));
        info!(
            tunnel_id = assignment.tunnel_id,
            hostname = assignment.hostname,
            "rathole tunnel process started"
        );

        Ok(Self {
            tunnel_id: assignment.tunnel_id.clone(),
            child,
            stdout_task,
            stderr_task,
            workdir,
            config_path,
        })
    }

    fn child_handle(&self) -> Arc<Mutex<Child>> {
        self.child.clone()
    }

    async fn shutdown(&mut self) -> Result<()> {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(status)) => {
                info!(
                    ?status,
                    tunnel_id = self.tunnel_id,
                    "rathole exited before shutdown request"
                );
            }
            Ok(None) => {
                info!(tunnel_id = self.tunnel_id, "stopping rathole tunnel");
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
            Err(error) => {
                warn!(?error, "rathole try_wait failed during shutdown");
            }
        }
        drop(child);

        if let Some(task) = self.stdout_task.take() {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = self.stderr_task.take() {
            task.abort();
            let _ = task.await;
        }

        let _ = fs::remove_file(&self.config_path).await;
        let _ = fs::remove_dir_all(&self.workdir).await;

        Ok(())
    }
}

fn build_rathole_config(
    settings: &OriginSettings,
    assignment: &TunnelAssignment,
) -> Result<String> {
    let creds = assignment
        .credentials
        .as_object()
        .ok_or_else(|| anyhow!("self-hosted tunnel credentials must be an object"))?;
    let server = creds
        .get("server")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| anyhow!("self-hosted tunnel credentials missing server"))?;
    let token = creds
        .get("token")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| anyhow!("self-hosted tunnel credentials missing token"))?;
    let service_name = creds
        .get("service")
        .or_else(|| creds.get("serviceName"))
        .and_then(JsonValue::as_str)
        .unwrap_or("runtime");
    let service_name = sanitize_service_name(service_name);
    let protocol = creds
        .get("protocol")
        .and_then(JsonValue::as_str)
        .unwrap_or("tcp");

    let port = resolve_local_port(settings, assignment);

    let local_host = match settings.bind_host.as_str() {
        "0.0.0.0" => "127.0.0.1",
        "::" => "[::1]",
        other => other,
    };
    Ok(format!(
        "[client]\nremote_addr = \"{server}\"\ndefault_token = \"{token}\"\nheartbeat_timeout = 40\nretry_interval = 1\n\n[client.transport]\ntype = \"tcp\"\n\n[client.transport.tcp]\nnodelay = true\nkeepalive_secs = 20\nkeepalive_interval = 8\n\n[client.services.{service_name}]\ntype = \"{protocol}\"\nlocal_addr = \"{local_host}:{port}\"\n",
        server = server,
        token = token,
        service_name = service_name,
        protocol = protocol,
        local_host = local_host,
        port = port
    ))
}

fn resolve_local_port(settings: &OriginSettings, assignment: &TunnelAssignment) -> u16 {
    let mut resolved = assignment
        .credentials
        .as_object()
        .and_then(|creds| {
            creds
                .get("localPort")
                .or_else(|| creds.get("local_port"))
                .or_else(|| creds.get("port"))
        })
        .and_then(parse_u16_value);

    if resolved.is_none() {
        resolved = assignment
            .metadata
            .as_ref()
            .and_then(|meta| meta.as_object())
            .and_then(|meta| {
                meta.get("localPort")
                    .or_else(|| meta.get("local_port"))
                    .or_else(|| meta.get("port"))
            })
            .and_then(parse_u16_value);
    }

    resolved
        .filter(|value| *value > 0)
        .unwrap_or(settings.bind_port)
}

fn parse_u16_value(value: &JsonValue) -> Option<u16> {
    match value {
        JsonValue::Number(num) => num.as_u64().and_then(|value| u16::try_from(value).ok()),
        JsonValue::String(raw) => raw.trim().parse::<u16>().ok(),
        _ => None,
    }
}

fn sanitize_service_name(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn spawn_log_task(
    pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    tunnel_id: String,
    stream: &'static str,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            debug!(
                tunnel_id = tunnel_id,
                stream = stream,
                message = trimmed,
                "tunnel log line"
            );
        }
    })
}

struct TunnelStatusEmitter {
    assignment: Arc<Mutex<TunnelAssignment>>,
    presence_metadata: Option<Arc<RwLock<JsonValue>>>,
    status_reporter: Option<TunnelStatusReporter>,
}

impl TunnelStatusEmitter {
    fn new(
        assignment: Arc<Mutex<TunnelAssignment>>,
        presence_metadata: Option<Arc<RwLock<JsonValue>>>,
        status_reporter: Option<TunnelStatusReporter>,
    ) -> Self {
        Self {
            assignment,
            presence_metadata,
            status_reporter,
        }
    }

    async fn mark_active(&self) {
        self.set_status("active").await;
    }

    async fn mark_refreshing(&self) {
        self.set_status("refreshing").await;
    }

    async fn mark_degraded(&self) {
        self.set_status("degraded").await;
    }

    async fn set_status(&self, status: &str) {
        {
            let mut assignment = self.assignment.lock().await;
            assignment.status = status.to_string();
            if status == "refreshing" {
                assignment.last_rotation_at = Utc::now();
            }
        }
        self.write_metadata().await;
        self.report_status(status).await;
    }

    // Note: keep `set_status` available to allow "starting" without exposing it broadly.

    async fn write_metadata(&self) {
        if let Some(handle) = &self.presence_metadata {
            let assignment = { self.assignment.lock().await.clone() };
            let mut guard = handle.write().await;
            if !guard.is_object() {
                *guard = JsonValue::Object(JsonMap::new());
            }
            let root = guard.as_object_mut().unwrap();
            let tunnel_value = root
                .entry("tunnel".to_string())
                .or_insert(JsonValue::Object(JsonMap::new()));
            if !tunnel_value.is_object() {
                *tunnel_value = JsonValue::Object(JsonMap::new());
            }
            let tunnel = tunnel_value.as_object_mut().unwrap();
            tunnel.insert(
                "provider".to_string(),
                JsonValue::String(assignment.provider.clone()),
            );
            tunnel.insert(
                "hostname".to_string(),
                JsonValue::String(assignment.hostname.clone()),
            );
            tunnel.insert("url".to_string(), JsonValue::String(assignment.url.clone()));
            tunnel.insert(
                "id".to_string(),
                JsonValue::String(assignment.tunnel_id.clone()),
            );
            tunnel.insert(
                "status".to_string(),
                JsonValue::String(assignment.status.clone()),
            );
            tunnel.insert(
                "expiresAt".to_string(),
                JsonValue::String(assignment.expires_at.to_rfc3339()),
            );
            tunnel.insert(
                "lastRotationAt".to_string(),
                JsonValue::String(assignment.last_rotation_at.to_rfc3339()),
            );
        }
    }

    async fn report_status(&self, status: &str) {
        if let Some(reporter) = &self.status_reporter {
            let tunnel_id = {
                let assignment = self.assignment.lock().await;
                assignment.tunnel_id.clone()
            };
            if let Err(error) = reporter.report(&tunnel_id, status).await {
                warn!(
                    ?error,
                    tunnel_id = tunnel_id,
                    "failed to report tunnel status to controller"
                );
            }
        }
    }
}

struct TunnelStatusReporter {
    client: reqwest::Client,
    controller_base_url: reqwest::Url,
    project_id: Uuid,
    /// Live credential shared with the registration path. The status loop runs
    /// for the whole life of the tunnel, so a token captured at spawn would go
    /// stale exactly like the presence beat did (#144).
    token_source: Option<SharedControllerToken>,
    fallback_token: Option<String>,
}

impl TunnelStatusReporter {
    fn new(
        controller_base_url: reqwest::Url,
        project_id: Uuid,
        token_source: Option<SharedControllerToken>,
        fallback_token: Option<String>,
    ) -> Self {
        Self {
            client: reqwest::Client::new(),
            controller_base_url,
            project_id,
            token_source,
            fallback_token,
        }
    }

    fn bearer(&self) -> Option<String> {
        if let Some(source) = &self.token_source {
            if let Some(token) = source
                .current()
                .map(|token| token.trim().to_string())
                .filter(|token| !token.is_empty())
            {
                return Some(token);
            }
        }
        self.fallback_token
            .as_deref()
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(str::to_string)
    }

    async fn report(&self, tunnel_id: &str, status: &str) -> Result<()> {
        let Some(bearer) = self.bearer() else {
            return Err(anyhow!("no controller token available for tunnel status"));
        };
        let mut url = self.controller_base_url.clone();
        url.path_segments_mut()
            .map_err(|_| anyhow!("controller base URL invalid for tunnel status update"))?
            .extend([
                "projects",
                &self.project_id.to_string(),
                "tunnels",
                tunnel_id,
                "status",
            ]);

        self.client
            .post(url)
            .bearer_auth(bearer)
            .json(&json!({
                "status": status,
            }))
            .send()
            .await?
            .error_for_status()
            .context("controller rejected tunnel status report")?;

        Ok(())
    }
}

fn tunnel_status_reporter(
    config: &Arc<Config>,
    origin_settings: &OriginSettings,
    token_source: Option<SharedControllerToken>,
) -> Option<TunnelStatusReporter> {
    let fallback = origin_settings
        .controller_internal_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    if token_source.is_none() && fallback.is_none() {
        return None;
    }
    Some(TunnelStatusReporter::new(
        config.controller_base_url.clone(),
        config.project_id,
        token_source,
        fallback,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_runtime_tunnel_request_omits_allocator_lease() {
        let runtime_id = Uuid::new_v4();
        let body = tunnel_request_body(runtime_id, None, JsonMap::new());

        assert_eq!(body["runtimeId"], runtime_id.to_string());
        assert!(body.get("runtimeLeaseId").is_none());
    }

    #[test]
    fn provider_managed_tunnel_request_preserves_allocator_lease() {
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let body = tunnel_request_body(runtime_id, Some(lease_id), JsonMap::new());

        assert_eq!(body["runtimeId"], runtime_id.to_string());
        assert_eq!(body["runtimeLeaseId"], lease_id.to_string());
    }
}
