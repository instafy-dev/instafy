//! Model-free preview restarts.
//!
//! When a member opens a preview whose runtime slept, the controller starts
//! the runtime and leaves a wake for it. This task polls
//! `POST /agent/preview-restarts/claim` and, for each claimed wake, does what
//! `instafy preview open` and the person who started the site did, without a
//! Codex turn, credits or a chat message:
//!
//! 1. If nothing answers on the port, start the recorded command: argv (never
//!    a shell), in its directory under the space's workspace (symlinks
//!    resolved, never outside), with the positive environment allowlist every
//!    helper process gets, detached into its own process group.
//! 2. Wait for the port.
//! 3. Start the preview tunnel client with the credentials the claim carries,
//!    and record it in the CLI's preview state file under the CLI's state
//!    lock, as `instafy preview open` does, so `instafy preview list/close`
//!    see it. A recorded client is reused or stopped only while its process
//!    is still that rathole client. A site this restart started is recorded
//!    with it, as `instafy preview open --start` records its own, so
//!    `instafy preview close` stops that site too.
//! 4. Report the outcome; the controller probes the site through the tunnel
//!    before it calls the wake done.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use tokio::time::sleep;
use tracing::{info, warn};
use uuid::Uuid;

use crate::agent::ShutdownSignal;
use crate::config::Config;
use crate::controller::{ControllerClient, Registration};
use crate::model_environment::{TERMINAL_HELPER_ENV_KEYS, apply_allowlisted_tokio_environment};

const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(3);
/// After the controller says it has no restart route (an older controller).
const UNSUPPORTED_POLL_INTERVAL: Duration = Duration::from_secs(300);
const PORT_WAIT: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const CLIENT_SETTLE: Duration = Duration::from_millis(250);
/// How long a restart waits for an `instafy preview` command that holds the
/// CLI's state lock, and when a lock left by one that died is taken over.
const STATE_LOCK_WAIT: Duration = Duration::from_secs(30);
const STATE_LOCK_STALE: Duration = Duration::from_secs(10 * 60);
/// Environment a restarted site may see on top of the helper baseline.
const SITE_EXTRA_ENV_KEYS: &[&str] = &["WORKSPACE_DIR", "WORKSPACE_PROJECT_DIR"];

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct PreviewServe {
    pub argv: Vec<String>,
    pub cwd: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRestart {
    pub wake_id: Uuid,
    pub preview_id: String,
    #[serde(default)]
    pub title: String,
    pub port: u16,
    #[serde(default = "default_path")]
    pub path: String,
    pub serve: PreviewServe,
    #[serde(default)]
    pub credentials: Option<JsonValue>,
}

fn default_path() -> String {
    "/".to_string()
}

#[derive(Debug, Deserialize)]
pub(crate) struct PreviewRestartClaim {
    #[serde(default)]
    pub(crate) restarts: Vec<PreviewRestart>,
}

/// Why a restart failed, as the controller shows it to every member who may
/// view the preview: a fixed plain reason, never a local path, user name or
/// command line. The full error stays in this agent's log.
#[derive(Debug)]
pub struct RestartFailed(pub String);

impl std::fmt::Display for RestartFailed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for RestartFailed {}

/// Gives a failure its plain reason unless a deeper step already gave one.
fn plainly<T>(result: Result<T>, reason: &str) -> Result<T> {
    result.map_err(|error| {
        if error.downcast_ref::<RestartFailed>().is_some() {
            error
        } else {
            error.context(RestartFailed(reason.to_string()))
        }
    })
}

fn failed(reason: impl Into<String>) -> anyhow::Error {
    RestartFailed(reason.into()).into()
}

/// What a failed restart reports: its plain reason, or a generic line.
pub fn reported_reason(error: &anyhow::Error) -> String {
    error
        .downcast_ref::<RestartFailed>()
        .map(|reason| reason.0.clone())
        .unwrap_or_else(|| "the site could not be restarted on its computer".to_string())
}

/// The previews this agent is restarting now, and the wakes waiting on each.
/// A preview is restarted once at a time; a wake claimed for it meanwhile
/// (the controller re-offers a claim it has no result for) gets the same
/// outcome instead of being dropped.
#[derive(Default)]
pub struct RestartsInFlight(Mutex<std::collections::HashMap<String, Vec<Uuid>>>);

impl RestartsInFlight {
    /// True when this starts a restart of the preview; false when one is
    /// under way, and the wake now waits on it.
    pub fn begin(&self, preview_id: &str, wake_id: Uuid) -> bool {
        let mut map = self.0.lock();
        match map.get_mut(preview_id) {
            Some(waiting) => {
                if !waiting.contains(&wake_id) {
                    waiting.push(wake_id);
                }
                false
            }
            None => {
                map.insert(preview_id.to_string(), vec![wake_id]);
                true
            }
        }
    }

    /// Ends the preview's restart: every wake that waited on it, the first
    /// one first.
    pub fn finish(&self, preview_id: &str) -> Vec<Uuid> {
        self.0.lock().remove(preview_id).unwrap_or_default()
    }
}

/// Where a restart runs and what it may use.
#[derive(Clone, Debug)]
pub struct RestartEnvironment {
    /// The space's workspace directory; `serve.cwd` is relative to it.
    pub workspace_dir: PathBuf,
    /// The home whose `.instafy` holds the CLI's preview state.
    pub home_dir: PathBuf,
    pub rathole_bin: String,
    pub controller_url: String,
    pub project_id: Uuid,
    pub port_wait: Duration,
    /// How long to wait for the CLI's state lock.
    pub state_lock_wait: Duration,
    /// In a container a loopback tunnel server is the host's (as the CLI
    /// maps it).
    pub in_container: bool,
}

impl RestartEnvironment {
    pub fn from_config(config: &Config) -> Self {
        let rathole_bin = config
            .origin
            .as_ref()
            .map(|origin| origin.rathole_bin.clone())
            .or_else(|| std::env::var("RATHOLE_BIN").ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "rathole".to_string());
        Self {
            workspace_dir: config.project_workspace_dir(&config.project_id),
            home_dir: std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/root")),
            rathole_bin,
            controller_url: config
                .controller_base_url
                .as_str()
                .trim_end_matches('/')
                .to_string(),
            project_id: config.project_id,
            port_wait: PORT_WAIT,
            state_lock_wait: STATE_LOCK_WAIT,
            in_container: Path::new("/.dockerenv").exists(),
        }
    }

    fn instafy_dir(&self) -> PathBuf {
        self.home_dir.join(".instafy")
    }
}

fn poll_interval() -> Option<Duration> {
    match std::env::var("RUNTIME_PREVIEW_RESTART_POLL_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
    {
        Some(0) => None,
        Some(ms) => Some(Duration::from_millis(ms.max(250))),
        None => Some(DEFAULT_POLL_INTERVAL),
    }
}

/// Poll for preview restarts for as long as this registration lives. The
/// caller aborts the task when the registration ends.
pub fn spawn_preview_restart_task(
    config: Arc<Config>,
    client: Arc<ControllerClient>,
    registration: Registration,
    shutdown: ShutdownSignal,
) -> Option<tokio::task::JoinHandle<()>> {
    let interval = poll_interval()?;
    let environment = RestartEnvironment::from_config(&config);
    let in_flight = Arc::new(RestartsInFlight::default());
    Some(tokio::spawn(async move {
        let mut wait = interval;
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => return,
                _ = sleep(wait) => {}
            }
            wait = interval;
            let restarts = match client.claim_preview_restarts(&registration).await {
                Ok(Some(restarts)) => restarts,
                Ok(None) => {
                    wait = UNSUPPORTED_POLL_INTERVAL;
                    continue;
                }
                Err(error) => {
                    warn!(?error, "preview restart claim failed");
                    continue;
                }
            };
            for restart in restarts {
                if !in_flight.begin(&restart.preview_id, restart.wake_id) {
                    // Already restarting it: this wake gets that outcome.
                    continue;
                }
                let client = client.clone();
                let registration = registration.clone();
                let environment = environment.clone();
                let in_flight = in_flight.clone();
                tokio::spawn(async move {
                    let preview_id = restart.preview_id.clone();
                    let wake_id = restart.wake_id;
                    let outcome = run_preview_restart(&environment, &restart).await;
                    let reason = match &outcome {
                        Ok(()) => {
                            info!(%preview_id, %wake_id, "preview restarted");
                            None
                        }
                        Err(error) => {
                            warn!(%preview_id, %wake_id, error = %format!("{error:#}"), "preview restart failed");
                            Some(reported_reason(error))
                        }
                    };
                    for wake_id in in_flight.finish(&preview_id) {
                        if let Err(report_error) = client
                            .report_preview_restart(&registration, wake_id, reason.as_deref())
                            .await
                        {
                            warn!(%preview_id, %wake_id, ?report_error, "preview restart report failed");
                        }
                    }
                });
            }
        }
    }))
}

/// Start the site (unless it already answers) and its tunnel client.
pub async fn run_preview_restart(
    environment: &RestartEnvironment,
    restart: &PreviewRestart,
) -> Result<()> {
    if restart.serve.argv.is_empty() || restart.serve.argv[0].trim().is_empty() {
        return Err(failed("the recorded start command is empty"));
    }
    let credentials = restart
        .credentials
        .as_ref()
        .ok_or_else(|| failed("the claim carried no tunnel credentials"))?;
    // Build the tunnel config first: bad credentials should not leave a
    // started site behind.
    let config_body = plainly(
        rathole_config(credentials, restart.port, environment.in_container),
        "the tunnel credentials were not usable",
    )?;

    let mut site = None;
    if !site_answers(restart.port, &restart.path).await {
        let cwd = plainly(
            resolve_serve_cwd(&environment.workspace_dir, &restart.serve.cwd),
            "the start command's directory is missing or outside the workspace",
        )?;
        let pid = plainly(
            start_site(environment, restart, &cwd).await,
            "the start command could not be run",
        )?;
        // Its command line now that it answers: what `instafy preview close`
        // checks before it stops the site.
        site = Some(StartedSite {
            pid,
            command: process_command_line(pid),
        });
    }
    // Waiting for the CLI's state lock and the client's first moments block:
    // off the async workers, so heartbeats and jobs keep running meanwhile.
    let environment = environment.clone();
    let restart = restart.clone();
    let started = tokio::task::spawn_blocking(move || {
        start_tunnel_client(&environment, &restart, &config_body, site.as_ref())
    })
    .await
    .map_err(|error| anyhow!("the tunnel client task failed: {error}"));
    plainly(
        started.and_then(|result| result),
        "the preview tunnel client could not be started",
    )
}

/// `serve.cwd` under the workspace, after resolving symlinks. Refuses
/// anything that leaves it.
pub fn resolve_serve_cwd(workspace_dir: &Path, relative: &str) -> Result<PathBuf> {
    let relative = relative.trim();
    if relative.starts_with('/')
        || relative.contains('\\')
        || relative.split('/').any(|segment| segment == "..")
    {
        bail!("the start command's directory {relative:?} is not inside the workspace");
    }
    let root = workspace_dir
        .canonicalize()
        .with_context(|| format!("the workspace {} is missing", workspace_dir.display()))?;
    let joined = if relative.is_empty() || relative == "." {
        root.clone()
    } else {
        root.join(relative)
    };
    let resolved = joined
        .canonicalize()
        .with_context(|| format!("the start command's directory {relative:?} is missing"))?;
    if !resolved.starts_with(&root) || !resolved.is_dir() {
        bail!("the start command's directory {relative:?} is not inside the workspace");
    }
    Ok(resolved)
}

/// The site a restart started: the process that leads its own process group,
/// and its command line once the site answered.
pub struct StartedSite {
    pub pid: i64,
    pub command: Option<String>,
}

/// Any HTTP answer below 500 means a server is there, as the CLI decides.
async fn site_answers(port: u16, path: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return false;
    };
    let path = if path.starts_with('/') { path } else { "/" };
    match client
        .get(format!("http://127.0.0.1:{port}{path}"))
        .send()
        .await
    {
        Ok(response) => response.status().as_u16() < 500,
        Err(_) => false,
    }
}

fn safe_segment(value: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "preview".to_string()
    } else {
        cleaned
    }
}

fn open_log(path: &Path) -> Result<std::fs::File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("failed to open {}", path.display()))
}

/// Start the recorded command and wait for the port. The pid of the process
/// that leads the site's process group.
#[cfg(unix)]
async fn start_site(
    environment: &RestartEnvironment,
    restart: &PreviewRestart,
    cwd: &Path,
) -> Result<i64> {
    let log_path = environment
        .instafy_dir()
        .join("cli-preview-logs")
        .join(format!("serve-{}.log", safe_segment(&restart.preview_id)));
    let log = open_log(&log_path)?;
    let mut command = tokio::process::Command::new(&restart.serve.argv[0]);
    command
        .args(&restart.serve.argv[1..])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .kill_on_drop(false);
    let extra: Vec<&str> = TERMINAL_HELPER_ENV_KEYS
        .iter()
        .chain(SITE_EXTRA_ENV_KEYS)
        .copied()
        .collect();
    apply_allowlisted_tokio_environment(&mut command, &extra);
    let mut child = command.spawn().with_context(|| {
        format!(
            "could not run {:?} in {}",
            restart.serve.argv[0], restart.serve.cwd
        )
    })?;
    let pid = child
        .id()
        .map(i64::from)
        .ok_or_else(|| failed("the start command has no process"))?;
    info!(preview_id = %restart.preview_id, pid, "started the preview's site");

    let deadline = Instant::now() + environment.port_wait;
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(failed(format!(
                "the start command exited ({status}) before the site answered on port {}",
                restart.port
            )));
        }
        if site_answers(restart.port, &restart.path).await {
            break;
        }
        if Instant::now() >= deadline {
            return Err(failed(format!(
                "the site did not answer on port {} within {} s",
                restart.port,
                environment.port_wait.as_secs()
            )));
        }
        sleep(Duration::from_millis(300)).await;
    }
    // Reap it whenever it exits; it outlives this restart.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(pid)
}

#[cfg(not(unix))]
async fn start_site(
    _environment: &RestartEnvironment,
    _restart: &PreviewRestart,
    _cwd: &Path,
) -> Result<i64> {
    Err(failed(
        "restarting a preview's site is not supported on this platform",
    ))
}

const LOOPBACK_HOSTS: [&str; 4] = ["127.0.0.1", "localhost", "::1", "[::1]"];

/// The tunnel server the client dials, mapped as the CLI maps it:
/// `INSTAFY_TUNNEL_SERVER_HOST` overrides the host, and inside a container a
/// loopback host is the Docker host.
pub fn resolve_tunnel_server(server: &str, in_container: bool) -> String {
    let server = server.trim();
    let Some((host, port)) = server.rsplit_once(':') else {
        return server.to_string();
    };
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return server.to_string();
    }
    if let Some(host) = std::env::var("INSTAFY_TUNNEL_SERVER_HOST")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return format!("{host}:{port}");
    }
    if in_container && LOOPBACK_HOSTS.contains(&host.to_ascii_lowercase().as_str()) {
        return format!("host.docker.internal:{port}");
    }
    server.to_string()
}

fn toml_safe(value: &str, what: &str) -> Result<String> {
    if value
        .chars()
        .any(|ch| ch == '"' || ch == '\\' || ch.is_control())
    {
        bail!("the tunnel {what} is not usable");
    }
    Ok(value.to_string())
}

/// The same client config `instafy preview open` writes.
pub fn rathole_config(credentials: &JsonValue, port: u16, in_container: bool) -> Result<String> {
    let text = |key: &str| {
        credentials
            .get(key)
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let server = text("server").ok_or_else(|| anyhow!("tunnel credentials missing server"))?;
    let token = text("token").ok_or_else(|| anyhow!("tunnel credentials missing token"))?;
    let service = text("service")
        .or_else(|| text("serviceName"))
        .unwrap_or("runtime");
    let protocol = text("protocol").unwrap_or("tcp");
    let server = toml_safe(&resolve_tunnel_server(server, in_container), "server")?;
    let token = toml_safe(token, "token")?;
    let service = toml_safe(service, "service")?;
    let protocol = toml_safe(protocol, "protocol")?;
    if !service
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        bail!("the tunnel service name is not usable");
    }
    Ok(format!(
        "[client]\nremote_addr = \"{server}\"\ndefault_token = \"{token}\"\nheartbeat_timeout = 40\nretry_interval = 1\n\n[client.transport]\ntype = \"tcp\"\n\n[client.transport.tcp]\nnodelay = true\nkeepalive_secs = 20\nkeepalive_interval = 8\n\n[client.services.{service}]\ntype = \"{protocol}\"\nlocal_addr = \"127.0.0.1:{port}\"\n"
    ))
}

#[cfg(unix)]
fn process_alive(pid: i64) -> bool {
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// A process's command line, arguments joined by spaces: `/proc` on Linux,
/// else `ps`. `None` when it cannot be read.
#[cfg(unix)]
fn process_command_line(pid: i64) -> Option<String> {
    if !process_alive(pid) {
        return None;
    }
    if let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) {
        let line = raw
            .split(|byte| *byte == 0)
            .filter(|part| !part.is_empty())
            .map(|part| String::from_utf8_lossy(part).into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        return (!line.is_empty()).then_some(line);
    }
    let output = std::process::Command::new("ps")
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!line.is_empty()).then_some(line)
}

#[cfg(not(unix))]
fn process_command_line(_pid: i64) -> Option<String> {
    None
}

/// The CLI's rule (`commandLineIsRatholeClient`): the line ends with exactly
/// `-c <config>`, and the program before it is the binary that was spawned or
/// a file whose name contains "rathole".
fn command_line_is_rathole_client(line: &str, config_path: &Path, binary: Option<&str>) -> bool {
    let config = config_path.display().to_string();
    if config.is_empty() {
        return false;
    }
    let line = line.trim();
    let Some(program) = line.strip_suffix(&format!(" -c {config}")) else {
        return false;
    };
    let program = program.trim_end();
    if program.is_empty() {
        return false;
    }
    if let Some(binary) = binary.filter(|binary| !binary.is_empty()) {
        if program == binary
            || program
                .strip_suffix(binary)
                .is_some_and(|before| before.ends_with(['/', ' ']))
        {
            return true;
        }
    }
    program
        .rsplit('/')
        .next()
        .is_some_and(|name| name.to_ascii_lowercase().contains("rathole"))
}

/// Whether `pid` is still the rathole client started with `config_path`. A
/// recorded pid may belong to another process after a restart, so nothing is
/// reused or signalled unless this holds. Unreadable counts as not ours.
#[cfg(unix)]
fn is_rathole_client_for(pid: i64, config_path: &Path, binary: Option<&str>) -> bool {
    process_command_line(pid)
        .is_some_and(|line| command_line_is_rathole_client(&line, config_path, binary))
}

#[cfg(not(unix))]
fn is_rathole_client_for(_pid: i64, _config_path: &Path, _binary: Option<&str>) -> bool {
    false
}

#[cfg(unix)]
fn stop_client(pid: i64, config_path: &Path, binary: Option<&str>) {
    if is_rathole_client_for(pid, config_path, binary) {
        // SAFETY: a plain SIGTERM to the rathole client this state file names,
        // checked just above.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

#[cfg(not(unix))]
fn stop_client(_pid: i64, _config_path: &Path, _binary: Option<&str>) {}

/// The CLI's state lock (`~/.instafy/cli-preview-state.lock`), so a restart
/// and an `instafy preview` command never overwrite each other's state.
struct StateLock(PathBuf);

impl StateLock {
    fn acquire(path: PathBuf, wait: Duration) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let deadline = Instant::now() + wait;
        loop {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(mut file) => {
                    std::io::Write::write_all(
                        &mut file,
                        std::process::id().to_string().as_bytes(),
                    )?;
                    return Ok(Self(path));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if lock_holder_is_gone(&path) {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return Err(failed(
                            "another instafy preview command on this space is still running",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn lock_holder_is_gone(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    let age = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .unwrap_or_default();
    if age > STATE_LOCK_STALE {
        return true;
    }
    match std::fs::read_to_string(path)
        .ok()
        .and_then(|text| text.trim().parse::<i64>().ok())
        .filter(|pid| *pid > 0)
    {
        Some(pid) => !process_alive_any(pid),
        None => age > Duration::from_secs(5),
    }
}

#[cfg(unix)]
fn process_alive_any(pid: i64) -> bool {
    process_alive(pid)
}

#[cfg(not(unix))]
fn process_alive_any(_pid: i64) -> bool {
    true
}

fn read_state(path: &Path) -> Vec<JsonValue> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<JsonValue>(&text).ok())
        .and_then(|state| state.get("previews").and_then(JsonValue::as_array).cloned())
        .map(|previews| previews.into_iter().filter(JsonValue::is_object).collect())
        .unwrap_or_default()
}

fn write_private(path: &Path, body: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        std::io::Write::write_all(&mut file, body.as_bytes())?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn entry_str<'a>(entry: &'a JsonValue, key: &str) -> Option<&'a str> {
    entry.get(key).and_then(JsonValue::as_str)
}

fn entry_i64(entry: &JsonValue, key: &str) -> Option<i64> {
    entry.get(key).and_then(JsonValue::as_i64)
}

/// Start (or keep) the preview's tunnel client and record it the way the CLI
/// does in `~/.instafy/cli-preview-state.json`, under the CLI's state lock.
/// The entry records the site too: the one this restart started, else the
/// one it already recorded (the site answered, so nothing was started); and
/// it keeps what `instafy preview open` recorded for this preview.
#[cfg(unix)]
fn start_tunnel_client(
    environment: &RestartEnvironment,
    restart: &PreviewRestart,
    config_body: &str,
    site: Option<&StartedSite>,
) -> Result<()> {
    use std::os::unix::process::CommandExt;

    let instafy = environment.instafy_dir();
    let segment = safe_segment(&restart.preview_id);
    let workdir = instafy.join("cli-preview-workdirs").join(&segment);
    let log_path = instafy
        .join("cli-preview-logs")
        .join(format!("preview-{segment}.log"));
    let config_path = workdir.join("rathole.toml");
    let state_path = instafy.join("cli-preview-state.json");
    let _lock = StateLock::acquire(
        instafy.join("cli-preview-state.lock"),
        environment.state_lock_wait,
    )?;
    std::fs::create_dir_all(&workdir)
        .with_context(|| format!("failed to create {}", workdir.display()))?;

    let binary = environment.rathole_bin.as_str();
    let previews = read_state(&state_path);
    let current = previews
        .iter()
        .find(|entry| entry_str(entry, "previewId") == Some(restart.preview_id.as_str()));
    let same_config = std::fs::read_to_string(&config_path).ok().as_deref() == Some(config_body);
    let mut pid = current
        .and_then(|entry| entry_i64(entry, "pid"))
        .filter(|pid| same_config && is_rathole_client_for(*pid, &config_path, Some(binary)));
    for stale in &previews {
        let stale_pid = entry_i64(stale, "pid").unwrap_or(-1);
        if Some(stale_pid) == pid {
            continue;
        }
        if entry_str(stale, "previewId") == Some(restart.preview_id.as_str())
            || entry_i64(stale, "localPort") == Some(i64::from(restart.port))
        {
            // Only a process that is still that entry's rathole client.
            let Some(stale_workdir) = entry_str(stale, "workdir") else {
                continue;
            };
            stop_client(
                stale_pid,
                &Path::new(stale_workdir).join("rathole.toml"),
                entry_str(stale, "binary"),
            );
        }
    }

    if pid.is_none() {
        write_private(&config_path, config_body)?;
        let log = open_log(&log_path)?;
        let mut command = std::process::Command::new(binary);
        command
            .arg("-c")
            .arg(&config_path)
            .current_dir(&workdir)
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .env_clear()
            .process_group(0);
        for key in ["PATH", "HOME", "LANG", "TZ"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .spawn()
            .with_context(|| format!("could not start {binary}"))?;
        std::thread::sleep(CLIENT_SETTLE);
        if let Some(status) = child.try_wait()? {
            return Err(failed(format!(
                "the preview tunnel client exited at once ({status})"
            )));
        }
        let child_pid = i64::from(child.id());
        // Reap it whenever it exits; it outlives this restart.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        pid = Some(child_pid);
    }

    let started_at = current
        .filter(|entry| entry_i64(entry, "pid") == pid)
        .and_then(|entry| entry_str(entry, "startedAt"))
        .map(str::to_string)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let mut entry = json!({
        "previewId": restart.preview_id,
        "projectId": environment.project_id,
        "title": restart.title,
        "localPort": restart.port,
        "path": restart.path,
        "controllerUrl": environment.controller_url,
        "pid": pid,
        "logFile": log_path,
        "workdir": workdir,
        "startedAt": started_at,
        "binary": binary,
    });
    if let Some(record) = entry.as_object_mut() {
        // What `instafy preview open` recorded for this same preview stays: how
        // `--start` starts the site, and the domain and Studio origin its viewers
        // come from (a site served in preview mode answers only those).
        let earlier = |key: &str| current.and_then(|entry| entry.get(key)).cloned();
        for key in ["start", "hostSuffix", "studioOrigin"] {
            if let Some(value) = earlier(key) {
                record.insert(key.to_string(), value);
            }
        }
        match site {
            Some(site) => {
                record.insert("startedPid".to_string(), json!(site.pid));
                if let Some(command) = &site.command {
                    record.insert("startedCommand".to_string(), json!(command));
                }
            }
            None => {
                for key in ["startedPid", "startedCommand"] {
                    if let Some(value) = earlier(key) {
                        record.insert(key.to_string(), value);
                    }
                }
            }
        }
    }
    let mut next = vec![entry];
    next.extend(previews.into_iter().filter(|existing| {
        entry_str(existing, "previewId") != Some(restart.preview_id.as_str())
            && entry_i64(existing, "localPort") != Some(i64::from(restart.port))
    }));
    write_private(
        &state_path,
        &serde_json::to_string_pretty(&json!({ "version": 1, "previews": next }))?,
    )?;
    Ok(())
}

#[cfg(not(unix))]
fn start_tunnel_client(
    _environment: &RestartEnvironment,
    _restart: &PreviewRestart,
    _config_body: &str,
    _site: Option<&StartedSite>,
) -> Result<()> {
    Err(failed(
        "restarting a preview's tunnel is not supported on this platform",
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn credentials(id: &str) -> JsonValue {
        json!({ "server": "127.0.0.1:2333", "token": "tunnel-token", "service": format!("svc_{id}") })
    }

    struct Sandbox {
        _dir: tempfile::TempDir,
        workspace: PathBuf,
        home: PathBuf,
        bin: PathBuf,
    }

    impl Sandbox {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let workspace = dir.path().join("workspace");
            let home = dir.path().join("home");
            let bin = dir.path().join("bin");
            for path in [&workspace, &home, &bin] {
                std::fs::create_dir_all(path).unwrap();
            }
            Self {
                workspace,
                home,
                bin,
                _dir: dir,
            }
        }

        fn script(&self, name: &str, body: &str) -> PathBuf {
            let path = self.bin.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        /// A tunnel client stand-in that records its arguments and stays up.
        fn rathole(&self) -> PathBuf {
            let marker = self.bin.join("rathole.args");
            self.script(
                "rathole",
                &format!("echo \"$@\" > '{}'\nexec sleep 30\n", marker.display()),
            )
        }

        fn environment(&self) -> RestartEnvironment {
            RestartEnvironment {
                workspace_dir: self.workspace.clone(),
                home_dir: self.home.clone(),
                rathole_bin: self.rathole().display().to_string(),
                controller_url: "http://controller.test".to_string(),
                project_id: Uuid::nil(),
                port_wait: Duration::from_secs(15),
                state_lock_wait: Duration::from_millis(500),
                in_container: false,
            }
        }

        fn state(&self) -> JsonValue {
            serde_json::from_str(
                &std::fs::read_to_string(self.home.join(".instafy/cli-preview-state.json"))
                    .unwrap(),
            )
            .unwrap()
        }
    }

    fn kill_recorded(sandbox: &Sandbox) {
        for entry in read_state(&sandbox.home.join(".instafy/cli-preview-state.json")) {
            let pid = entry_i64(&entry, "pid").unwrap_or(-1);
            if process_alive(pid) {
                // SAFETY: test-only; the stand-in client this test started.
                unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            }
            // And the site the restart started, its whole process group, when it is still that site.
            let site = entry_i64(&entry, "startedPid").unwrap_or(-1);
            if process_command_line(site).is_some()
                && process_command_line(site).as_deref() == entry_str(&entry, "startedCommand")
            {
                // SAFETY: test-only; the site this test's restart started, checked just above.
                unsafe { libc::kill(-(site as libc::pid_t), libc::SIGTERM) };
            }
        }
    }

    #[test]
    fn the_start_directory_stays_inside_the_workspace() {
        let sandbox = Sandbox::new();
        std::fs::create_dir_all(sandbox.workspace.join("site/www")).unwrap();
        let outside = sandbox.home.clone();
        std::os::unix::fs::symlink(&outside, sandbox.workspace.join("escape")).unwrap();
        let root = sandbox.workspace.canonicalize().unwrap();
        assert_eq!(resolve_serve_cwd(&sandbox.workspace, ".").unwrap(), root);
        assert_eq!(
            resolve_serve_cwd(&sandbox.workspace, "site/www").unwrap(),
            root.join("site/www")
        );
        for bad in [
            "/etc",
            "../home",
            "site/../../home",
            "escape",
            "missing",
            "a\\b",
        ] {
            assert!(resolve_serve_cwd(&sandbox.workspace, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_tunnel_config_is_the_clis_with_the_server_mapped_in_a_container() {
        let config = rathole_config(&credentials("p1"), 4173, false).unwrap();
        assert!(config.contains("remote_addr = \"127.0.0.1:2333\""));
        assert!(config.contains("default_token = \"tunnel-token\""));
        assert!(config.contains("[client.services.svc_p1]"));
        assert!(config.contains("local_addr = \"127.0.0.1:4173\""));
        let mapped = rathole_config(&credentials("p1"), 4173, true).unwrap();
        assert!(mapped.contains("remote_addr = \"host.docker.internal:2333\""));
        assert_eq!(
            resolve_tunnel_server("rathole.example:2333", true),
            "rathole.example:2333"
        );
        for bad in [
            json!({ "token": "t" }),
            json!({ "server": "s:1" }),
            json!({ "server": "s:1", "token": "a\"b" }),
            json!({ "server": "s:1", "token": "t", "service": "x]\n[y" }),
        ] {
            assert!(rathole_config(&bad, 1, false).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn a_restart_runs_argv_in_its_directory_with_a_stripped_environment_then_the_tunnel()
    -> Result<()> {
        let sandbox = Sandbox::new();
        let site = sandbox.workspace.join("site");
        std::fs::create_dir_all(&site)?;
        std::fs::write(site.join("index.html"), "<h1>ok</h1>")?;
        let port = free_port();
        // The site records its directory and environment, then serves.
        let serve = sandbox.script(
            "serve",
            "pwd > started.cwd\nenv > started.env\nexec python3 -m http.server \"$1\" --bind 127.0.0.1\n",
        );
        // SAFETY: test-only; no other test reads this variable.
        unsafe { std::env::set_var("CONTROLLER_ACCESS_TOKEN", "must-not-leak") };
        let environment = sandbox.environment();
        let restart = PreviewRestart {
            wake_id: Uuid::new_v4(),
            preview_id: "4f1c2b8e-0000-4000-8000-000000000001".to_string(),
            title: "Site preview".to_string(),
            port,
            path: "/".to_string(),
            serve: PreviewServe {
                argv: vec![serve.display().to_string(), port.to_string()],
                cwd: "./site".to_string(),
            },
            credentials: Some(credentials("p1")),
        };
        let outcome = run_preview_restart(&environment, &restart).await;
        for _ in 0..30 {
            if sandbox.bin.join("rathole.args").exists() {
                break;
            }
            sleep(Duration::from_millis(100)).await;
        }
        let state = sandbox.state();
        let site_command =
            entry_i64(&state["previews"][0], "startedPid").and_then(process_command_line);
        let answered = site_answers(port, "/").await;
        kill_recorded(&sandbox);
        // SAFETY: as above.
        unsafe { std::env::remove_var("CONTROLLER_ACCESS_TOKEN") };
        outcome?;

        assert!(answered, "the site answers");
        let listing: Vec<_> = std::fs::read_dir(&site)?
            .filter_map(|entry| entry.ok().map(|entry| entry.file_name()))
            .collect();
        let cwd = std::fs::read_to_string(site.join("started.cwd"))
            .with_context(|| format!("started.cwd in {listing:?}"))?;
        assert_eq!(Path::new(cwd.trim()).canonicalize()?, site.canonicalize()?);
        let env = std::fs::read_to_string(site.join("started.env")).context("started.env")?;
        assert!(!env.contains("must-not-leak"), "{env}");
        assert!(env.lines().any(|line| line.starts_with("PATH=")));

        let entry = &state["previews"][0];
        assert_eq!(entry["previewId"], json!(restart.preview_id));
        assert_eq!(entry["localPort"], json!(port));
        assert!(entry.get("hostSuffix").is_none());
        // The site it started is recorded with the preview, as `open --start`
        // records its own, so `instafy preview close` stops it.
        assert!(
            entry["startedPid"].as_i64().is_some_and(|pid| pid > 0),
            "{entry}"
        );
        let site_command = site_command.context("the started site runs")?;
        assert!(site_command.contains("http.server"), "{site_command}");
        assert_eq!(entry["startedCommand"], json!(site_command));
        assert_eq!(entry["binary"], json!(environment.rathole_bin));
        assert_eq!(entry["controllerUrl"], "http://controller.test");
        let config = std::fs::read_to_string(sandbox.home.join(
            ".instafy/cli-preview-workdirs/4f1c2b8e-0000-4000-8000-000000000001/rathole.toml",
        ))?;
        assert!(config.contains(&format!("local_addr = \"127.0.0.1:{port}\"")));
        let args =
            std::fs::read_to_string(sandbox.bin.join("rathole.args")).context("rathole.args")?;
        assert!(args.starts_with("-c "), "{args}");
        Ok(())
    }

    #[tokio::test]
    async fn a_site_that_already_answers_is_not_started_again() -> Result<()> {
        let sandbox = Sandbox::new();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buffer = [0u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                    )
                    .await;
            }
        });
        let marker = sandbox.workspace.join("ran");
        let never = sandbox.script("never", &format!("touch '{}'\n", marker.display()));
        let restart = PreviewRestart {
            wake_id: Uuid::new_v4(),
            preview_id: "already".to_string(),
            title: String::new(),
            port,
            path: "/".to_string(),
            serve: PreviewServe {
                argv: vec![never.display().to_string()],
                cwd: ".".to_string(),
            },
            credentials: Some(credentials("already")),
        };
        // `open --start` started this site earlier and recorded it.
        let earlier = json!({
            "start": { "argv": ["node", "site.mjs", "{port}"], "cwd": "." },
            "startedPid": 999_999_999,
            "startedCommand": "node site.mjs 4173",
            "hostSuffix": "preview.test",
            "studioOrigin": "https://studio.test",
        });
        let mut recorded = earlier.clone();
        recorded["previewId"] = json!("already");
        recorded["localPort"] = json!(port);
        recorded["pid"] = json!(-1);
        std::fs::create_dir_all(sandbox.home.join(".instafy"))?;
        std::fs::write(
            sandbox.home.join(".instafy/cli-preview-state.json"),
            json!({ "version": 1, "previews": [recorded] }).to_string(),
        )?;
        let outcome = run_preview_restart(&sandbox.environment(), &restart).await;
        let state = sandbox.state();
        kill_recorded(&sandbox);
        server.abort();
        outcome?;
        assert!(!marker.exists(), "the start command must not run");
        // The record of the site that answered is kept, and so is what the
        // preview's viewers come from.
        let entry = &state["previews"][0];
        for key in [
            "start",
            "startedPid",
            "startedCommand",
            "hostSuffix",
            "studioOrigin",
        ] {
            assert_eq!(entry[key], earlier[key], "{key}");
        }
        Ok(())
    }

    #[tokio::test]
    async fn a_start_command_that_exits_fails_the_restart_with_its_status() {
        let sandbox = Sandbox::new();
        let port = free_port();
        let restart = PreviewRestart {
            wake_id: Uuid::new_v4(),
            preview_id: "exits".to_string(),
            title: String::new(),
            port,
            path: "/".to_string(),
            serve: PreviewServe {
                argv: vec!["sh".to_string(), "-c".to_string(), "exit 7".to_string()],
                cwd: ".".to_string(),
            },
            credentials: Some(credentials("exits")),
        };
        let error = run_preview_restart(&sandbox.environment(), &restart)
            .await
            .expect_err("must fail");
        let message = format!("{error:#}");
        assert!(
            message.contains("exited") && message.contains('7'),
            "{message}"
        );
        assert_eq!(
            reported_reason(&error),
            format!(
                "the start command exited (exit status: 7) before the site answered on port {port}"
            )
        );
        assert!(
            !sandbox
                .home
                .join(".instafy/cli-preview-state.json")
                .exists(),
            "no tunnel client for a site that is not up"
        );

        let missing = PreviewRestart {
            serve: PreviewServe {
                argv: vec!["definitely-not-a-program-xyz".to_string()],
                cwd: ".".to_string(),
            },
            ..restart
        };
        let error = run_preview_restart(&sandbox.environment(), &missing)
            .await
            .expect_err("must fail");
        assert!(format!("{error:#}").contains("definitely-not-a-program-xyz"));
        // Members see a plain reason: no command line, path or user name.
        assert_eq!(
            reported_reason(&error),
            "the start command could not be run"
        );

        let outside = PreviewRestart {
            serve: PreviewServe {
                argv: vec!["true".to_string()],
                cwd: "not-there".to_string(),
            },
            ..missing
        };
        let error = run_preview_restart(&sandbox.environment(), &outside)
            .await
            .expect_err("must fail");
        let home = sandbox.home.display().to_string();
        assert!(format!("{error:#}").contains("not-there"), "{error:#}");
        let reason = reported_reason(&error);
        assert_eq!(
            reason,
            "the start command's directory is missing or outside the workspace"
        );
        assert!(!reason.contains(&home));
        let mut broken = sandbox.environment();
        broken.workspace_dir = sandbox.home.join("no-workspace");
        let error = run_preview_restart(&broken, &outside)
            .await
            .expect_err("must fail");
        assert!(format!("{error:#}").contains("no-workspace"), "{error:#}");
        assert!(!reported_reason(&error).contains("no-workspace"));
        assert_eq!(
            reported_reason(&anyhow!("failed to open /home/someone/.instafy/x.log")),
            "the site could not be restarted on its computer"
        );
    }

    #[test]
    fn a_wake_claimed_again_mid_restart_waits_for_that_restart_and_gets_its_outcome() {
        let in_flight = RestartsInFlight::default();
        let (first, again, newer) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        assert!(in_flight.begin("p", first), "the first claim restarts it");
        assert!(
            !in_flight.begin("p", first),
            "a re-claim of the same wake joins"
        );
        assert!(!in_flight.begin("p", again), "another wake of it joins");
        assert!(!in_flight.begin("p", again));
        assert!(
            in_flight.begin("q", newer),
            "another preview restarts on its own"
        );
        assert_eq!(
            in_flight.finish("p"),
            vec![first, again],
            "each reported once"
        );
        assert!(
            in_flight.begin("p", newer),
            "a later wake restarts it again"
        );
        assert_eq!(in_flight.finish("q"), vec![newer]);
        assert_eq!(in_flight.finish("missing"), Vec::<Uuid>::new());
    }

    #[test]
    fn only_the_rathole_client_of_that_config_counts_as_the_recorded_client() {
        let config = Path::new("/home/u/.instafy/cli-preview-workdirs/p1/rathole.toml");
        let line = |program: &str| format!("{program} -c {}", config.display());
        assert!(command_line_is_rathole_client(
            &line("/usr/local/bin/rathole"),
            config,
            None
        ));
        assert!(command_line_is_rathole_client(
            &line("/opt/bin/tunnel-client"),
            config,
            Some("/opt/bin/tunnel-client")
        ));
        for other in [
            line("/usr/bin/less"),
            format!("/usr/bin/tail -f {}", config.display()),
            format!("rathole -c {}.bak", config.display()),
            format!("rathole -c /other/rathole.toml"),
            String::new(),
        ] {
            assert!(
                !command_line_is_rathole_client(&other, config, None),
                "{other}"
            );
        }
    }

    #[tokio::test]
    async fn a_recorded_pid_that_is_no_longer_its_rathole_client_is_left_alone() -> Result<()> {
        let sandbox = Sandbox::new();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buffer = [0u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                    )
                    .await;
            }
        });
        // The pid the state file names now belongs to some other process.
        let mut bystander = std::process::Command::new("sleep").arg("30").spawn()?;
        let preview_id = "reused-pid";
        let workdir = sandbox
            .home
            .join(".instafy/cli-preview-workdirs")
            .join(preview_id);
        std::fs::create_dir_all(&workdir)?;
        write_private(
            &sandbox.home.join(".instafy/cli-preview-state.json"),
            &json!({ "version": 1, "previews": [{
                "previewId": preview_id, "localPort": port, "pid": bystander.id(),
                "workdir": workdir, "binary": "rathole",
            }]})
            .to_string(),
        )?;
        let restart = PreviewRestart {
            wake_id: Uuid::new_v4(),
            preview_id: preview_id.to_string(),
            title: String::new(),
            port,
            path: "/".to_string(),
            serve: PreviewServe {
                argv: vec!["true".to_string()],
                cwd: ".".to_string(),
            },
            credentials: Some(credentials("reused")),
        };
        let outcome = run_preview_restart(&sandbox.environment(), &restart).await;
        let still_running = bystander.try_wait()?.is_none();
        let _ = bystander.kill();
        let _ = bystander.wait();
        let state = sandbox.state();
        kill_recorded(&sandbox);
        server.abort();
        outcome?;
        assert!(
            still_running,
            "a process that is not the recorded rathole client must not be signalled"
        );
        assert_ne!(
            state["previews"][0]["pid"],
            json!(bystander.id()),
            "a new client was started"
        );
        Ok(())
    }

    #[tokio::test]
    async fn a_restart_waits_for_the_clis_state_lock_and_takes_over_a_dead_holders() -> Result<()> {
        let sandbox = Sandbox::new();
        let port = free_port();
        let lock = sandbox.home.join(".instafy/cli-preview-state.lock");
        std::fs::create_dir_all(lock.parent().unwrap())?;
        let restart = |id: &str| PreviewRestart {
            wake_id: Uuid::new_v4(),
            preview_id: id.to_string(),
            title: String::new(),
            port,
            path: "/".to_string(),
            serve: PreviewServe {
                argv: vec!["true".to_string()],
                cwd: ".".to_string(),
            },
            credentials: Some(credentials(id)),
        };
        // A live `instafy preview` command holds it: the restart gives up and writes nothing.
        std::fs::write(&lock, std::process::id().to_string())?;
        let error =
            start_tunnel_client(&sandbox.environment(), &restart("held"), "[client]\n", None)
                .expect_err("must wait for the lock");
        assert!(format!("{error:#}").contains("still running"), "{error:#}");
        assert!(
            !sandbox
                .home
                .join(".instafy/cli-preview-state.json")
                .exists()
        );
        assert!(lock.exists(), "someone else's lock stays");

        // Its holder died: the lock is taken over, and released after.
        std::fs::write(&lock, "999999999")?;
        start_tunnel_client(&sandbox.environment(), &restart("free"), "[client]\n", None)?;
        kill_recorded(&sandbox);
        assert!(!lock.exists());
        assert_eq!(sandbox.state()["previews"][0]["previewId"], "free");
        Ok(())
    }
}
