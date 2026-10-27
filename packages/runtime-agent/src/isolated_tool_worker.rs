//! One controller-admitted tool turn in a private process and working directory.
//!
//! The runtime keeps registration, lease, origin and publication authority. This child receives
//! only a job's scoped proxy/controller credentials and reports events/results over bounded IPC.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::CodexErrorInfo;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::codex::{CodexClient, CodexConfig, CodexExecutionError, CodexRunOptions};
use crate::job_cancel::JobCancelSignal;
use crate::model_environment::{PERSISTENT_HELPER_BASE_ENV_KEYS, is_model_child_excluded_env_key};
use crate::task_usage::{TaskUsage, UsagePhase};

mod process_tree;

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_EVENTS: usize = 16_384;
const RUN_TIMEOUT: Duration = Duration::from_secs(600);
const CANCEL_DRAIN: Duration = Duration::from_secs(8);
static CLEANUP_UNCONFIRMED: AtomicBool = AtomicBool::new(false);

/// Once a child lifetime cannot be confirmed, the owning runtime must stop admitting jobs.
pub fn runtime_reuse_is_safe() -> bool {
    !CLEANUP_UNCONFIRMED.load(Ordering::Acquire)
}

fn mark_cleanup_unconfirmed() {
    CLEANUP_UNCONFIRMED.store(true, Ordering::Release);
}

/// Job-scoped settings separated from granted secrets by the trusted parent.
/// Never log this object: the environment contains the job's secret values.
#[derive(Default)]
pub struct IsolatedWorkerJobConfig {
    pub environment: HashMap<String, String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
}

/// Constructed by the trusted parent after verifying the job's claims. Never log this object.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IsolatedToolWorkerRequest {
    pub workspace_dir: PathBuf,
    pub state_dir: PathBuf,
    pub prompt: String,
    pub project_id: Uuid,
    pub job_id: Uuid,
    pub conversation_id: Option<Uuid>,
    pub proxy_base_url: String,
    pub proxy_token: String,
    pub controller_base_url: String,
    pub controller_token: Option<String>,
    pub controller_token_scopes: Vec<String>,
    pub controller_token_expires_at: Option<String>,
    pub job_environment: HashMap<String, String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    /// The project's skill-pack folder (`INSTAFY_CACHE_DIR`): the one place outside the snapshot
    /// and the fresh private state the worker may write, so a pack's caches and service health
    /// outlast the turn.
    #[serde(default)]
    pub cache_dir: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IsolatedToolWorkerOutput {
    pub final_json: Value,
    #[serde(default)]
    pub events: Vec<Value>,
    pub usage_artifact: Option<Value>,
}

#[derive(Debug, thiserror::Error, Serialize, Deserialize)]
#[error("{message}")]
pub struct IsolatedToolWorkerFailure {
    pub message: String,
    pub codex_error_info: Option<CodexErrorInfo>,
    pub usage_artifact: Option<Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum WorkerFrame {
    Event(Value),
    Usage(Value),
    Finished(IsolatedToolWorkerOutput),
    Failed(IsolatedToolWorkerFailure),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ParentFrame {
    Cancel,
}

impl IsolatedToolWorkerRequest {
    fn validate(&self) -> Result<()> {
        // Sandboxed code never holds controller authority. A controller token
        // could, for one, record a preview start command (`instafy preview
        // open --serve-cmd`), which the runtime agent later runs outside the
        // sandbox when a member opens the stopped preview. Fail closed.
        ensure!(
            self.controller_token.is_none()
                && self.controller_token_scopes.is_empty()
                && self.controller_token_expires_at.is_none(),
            "an isolated worker never gets a controller token"
        );
        ensure_supported_platform(std::env::consts::OS)?;
        ensure!(
            !self.prompt.trim().is_empty(),
            "isolated worker prompt is empty"
        );
        ensure!(
            self.prompt.len() <= MAX_FRAME_BYTES / 2,
            "isolated worker prompt is too large"
        );
        ensure!(
            !self.proxy_token.trim().is_empty(),
            "isolated worker proxy token is missing"
        );
        ensure!(
            self.proxy_token.len() <= 128 * 1024
                && self
                    .controller_token
                    .as_ref()
                    .is_none_or(|token| token.len() <= 128 * 1024),
            "isolated worker credential is too large"
        );
        ensure!(
            self.controller_token_scopes.len() <= 64
                && self
                    .controller_token_scopes
                    .iter()
                    .all(|scope| scope.len() <= 256),
            "invalid isolated worker controller scopes"
        );
        for raw in [&self.proxy_base_url, &self.controller_base_url] {
            let url = reqwest::Url::parse(raw).context("invalid isolated worker endpoint")?;
            ensure!(
                matches!(url.scheme(), "http" | "https"),
                "unsupported worker endpoint scheme"
            );
            ensure!(
                url.username().is_empty() && url.password().is_none(),
                "worker endpoint contains credentials"
            );
        }
        ensure!(
            self.workspace_dir.is_absolute() && self.state_dir.is_absolute(),
            "isolated worker roots must be absolute"
        );
        let workspace =
            std::fs::canonicalize(&self.workspace_dir).context("worker workspace is missing")?;
        let state =
            std::fs::canonicalize(&self.state_dir).context("worker state directory is missing")?;
        ensure!(
            workspace.is_dir() && state.is_dir(),
            "worker roots must be directories"
        );
        ensure_no_repository_ancestry(&workspace)?;
        ensure!(
            !workspace.starts_with(&state) && !state.starts_with(&workspace),
            "worker workspace and private state must be separate"
        );
        if let Some(cache) = &self.cache_dir {
            ensure!(
                cache.is_absolute(),
                "isolated worker cache folder must be absolute"
            );
            let cache = std::fs::canonicalize(cache).context("worker cache folder is missing")?;
            ensure!(cache.is_dir(), "worker cache folder must be a directory");
            ensure!(
                [&workspace, &state]
                    .iter()
                    .all(|root| !cache.starts_with(root) && !root.starts_with(&cache)),
                "worker cache folder must be separate from the workspace and private state"
            );
        }
        validate_job_environment(&self.job_environment)
    }
}

pub(crate) fn validate_job_environment(environment: &HashMap<String, String>) -> Result<()> {
    ensure!(
        environment.len() <= 256,
        "too many worker environment entries"
    );
    for (key, value) in environment {
        ensure!(
            safe_job_environment_key(key),
            "reserved isolated worker environment key"
        );
        ensure!(
            value.len() <= 128 * 1024 && !value.contains('\0'),
            "invalid worker environment value"
        );
    }
    Ok(())
}

fn ensure_supported_platform(platform: &str) -> Result<()> {
    ensure!(
        matches!(platform, "linux" | "macos"),
        "isolated tool workers require Linux or macOS filesystem sandbox enforcement"
    );
    Ok(())
}

fn ensure_no_repository_ancestry(workspace: &Path) -> Result<()> {
    // Trusted startup metadata queries must not discover a host repository above the copy.
    // Inspect only entry metadata, including dangling pointers; never follow/read .git.
    for (depth, ancestor) in workspace.ancestors().enumerate() {
        ensure!(
            depth < 128,
            "isolated worker workspace ancestry is too deep"
        );
        match std::fs::symlink_metadata(ancestor.join(".git")) {
            Ok(_) => bail!("isolated worker workspace must be outside repository ancestry"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).context("could not verify isolated worker repository boundary");
            }
        }
    }
    Ok(())
}

fn safe_job_environment_key(key: &str) -> bool {
    // Trusted metadata assembled by the parent from the authorized job's secret inventory.
    if key == "INSTAFY_PROJECT_SECRET_INVENTORY" {
        return true;
    }
    let upper = key.to_ascii_uppercase();
    !key.is_empty()
        && key.len() <= 128
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && !is_model_child_excluded_env_key(key)
        && ![
            "CODEX",
            "OPENAI",
            "INSTAFY",
            "CONTROLLER",
            "RUNTIME",
            "ORIGIN",
            "WORKSPACE",
            "LD_",
            "DYLD_",
            "NODE_",
            "PYTHON",
            "RUST",
            "BASH",
            "ZDOT",
            "XDG_",
            "CARGO_",
            "DENO_",
            "V8_",
            "NPM_CONFIG_",
            "GIT_",
        ]
        .iter()
        .any(|prefix| upper.starts_with(prefix))
        && ![
            "HOME",
            "PATH",
            "USER",
            "SHELL",
            "ENV",
            "TMPDIR",
            "TMP",
            "TEMP",
            "TZ",
            "PROJECT_ID",
            "SPACE_ID",
            "CONVERSATION_ID",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "ALL_PROXY",
            "NO_PROXY",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "RUBYOPT",
            "PERL5OPT",
            "VIRTUAL_ENV",
        ]
        .contains(&upper.as_str())
}

pub async fn run(
    request: IsolatedToolWorkerRequest,
    on_event: &mut (dyn FnMut(&Value) -> Result<()> + Send),
    cancel: JobCancelSignal,
) -> Result<IsolatedToolWorkerOutput> {
    run_with_program(&std::env::current_exe()?, request, on_event, cancel).await
}

/// Explicit executable is also used by integration tests against the real packaged entry point.
pub async fn run_with_program(
    program: &Path,
    request: IsolatedToolWorkerRequest,
    on_event: &mut (dyn FnMut(&Value) -> Result<()> + Send),
    cancel: JobCancelSignal,
) -> Result<IsolatedToolWorkerOutput> {
    ensure!(
        runtime_reuse_is_safe(),
        "isolated worker cleanup is unconfirmed; runtime cannot accept further work"
    );
    request.validate()?;
    ensure!(
        !cancel.is_canceled(),
        "lease lost before isolated worker start"
    );
    let encoded = encode_frame(&request)?;
    let mut command = tokio::process::Command::new(program);
    command
        .arg("--isolated-tool-worker")
        .current_dir(&request.workspace_dir)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // No machine credentials or model settings cross from the runtime's process environment.
    command.envs(worker_process_environment(
        crate::skill_packs::installed_packs(),
        std::env::vars_os(),
    ));
    command.env("INSTAFY_RUNTIME_PARENT_DISPOSITION", "1");
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .context("failed to start isolated tool worker")?;
    let mut tree = process_tree::ProcessTree::new(child.id().context("worker has no process id")?);
    let stderr = child
        .stderr
        .take()
        .context("worker stderr is unavailable")?;
    let stderr_task = tokio::spawn(async move {
        let mut retained = Vec::new();
        let mut stderr = stderr;
        let mut chunk = [0u8; 4096];
        while let Ok(count) = stderr.read(&mut chunk).await {
            if count == 0 {
                break;
            }
            let keep = count.min(16_384usize.saturating_sub(retained.len()));
            retained.extend_from_slice(&chunk[..keep]);
        }
        retained
    });
    let mut input = child.stdin.take().context("worker stdin is unavailable")?;
    let mut output = child
        .stdout
        .take()
        .context("worker stdout is unavailable")?;
    let mut events = Vec::new();
    let mut latest_usage = None;
    let mut output_bytes = 0usize;
    let mut cancellation_started = None;
    let mut poll = tokio::time::interval(Duration::from_millis(50));
    let deadline = tokio::time::Instant::now() + RUN_TIMEOUT;
    let result = async {
        tokio::time::timeout(Duration::from_secs(10), input.write_all(&encoded)).await
            .context("worker request pipe timed out")?.context("failed to send worker request")?;
        loop {
            // Keep partial frame reads alive across cancellation/monitor ticks.
            let next = read_async_frame::<WorkerFrame>(&mut output);
            tokio::pin!(next);
            let frame = loop { tokio::select! {
                biased;
                _ = cancel.cancelled(), if cancellation_started.is_none() => {
                    cancellation_started = Some(tokio::time::Instant::now());
                    let _ = input.write_all(&encode_frame(&ParentFrame::Cancel)?).await;
                    continue;
                }
                _ = poll.tick() => {
                    tree.observe();
                    if cancellation_started.is_some_and(|at: tokio::time::Instant| at.elapsed() >= CANCEL_DRAIN) {
                        bail!("lease lost; isolated worker cancellation drain timed out");
                    }
                    if tokio::time::Instant::now() >= deadline {
                        bail!("isolated tool worker timed out");
                    }
                    continue;
                }
                frame = &mut next => break frame?,
            }};
            output_bytes = output_bytes.checked_add(frame.1).context("worker output size overflow")?;
            ensure!(output_bytes <= MAX_OUTPUT_BYTES, "isolated worker output exceeded its byte limit");
            match frame.0 {
                WorkerFrame::Usage(artifact) => {
                    ensure!(
                        frame.1 <= 64 * 1024 && artifact.get("kind").and_then(Value::as_str) == Some("ai/task-usage")
                            && artifact.get("calls").and_then(Value::as_array).is_some_and(|calls| calls.len() <= 128 && calls.iter().all(Value::is_object)),
                        "invalid isolated worker usage snapshot"
                    );
                    latest_usage = Some(artifact);
                }
                WorkerFrame::Event(event) => {
                    ensure!(events.len() < MAX_EVENTS, "isolated worker emitted too many events");
                    on_event(&event)?;
                    events.push(event);
                }
                WorkerFrame::Finished(mut result) => {
                    result.usage_artifact = result.usage_artifact.or_else(|| latest_usage.clone());
                    if cancellation_started.is_some() || cancel.is_canceled() {
                        return Err(IsolatedToolWorkerFailure {
                            message: "lease lost during isolated worker execution".into(),
                            codex_error_info: None,
                            usage_artifact: result.usage_artifact,
                        }.into());
                    }
                    result.events = events;
                    return Ok(result);
                }
                WorkerFrame::Failed(mut failure) => {
                    failure.usage_artifact = failure.usage_artifact.or_else(|| latest_usage.clone());
                    return Err(failure.into());
                }
            }
        }
    }.await;
    // Parent-originated failures have no final child receipt. Preserve only the exact
    // snapshots already received, explicitly partial; absence never means zero usage.
    let result = result.map_err(|error: anyhow::Error| {
        if error.downcast_ref::<IsolatedToolWorkerFailure>().is_some() {
            error
        } else {
            IsolatedToolWorkerFailure {
                message: redact_error(&request, &format!("{error:#}")),
                codex_error_info: None,
                usage_artifact: latest_usage
                    .map(|artifact| partial_usage(artifact, cancel.is_canceled())),
            }
            .into()
        }
    });
    drop(input);
    // Always drain descendants, including on protocol errors and a successful root response.
    let cleanup = tree.terminate_and_confirm().await;
    let _ = child.start_kill();
    let reaped = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    let stderr = tokio::time::timeout(Duration::from_secs(1), stderr_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    if cleanup.is_err() || !matches!(reaped, Ok(Ok(_))) {
        mark_cleanup_unconfirmed();
        let cleanup_message = cleanup
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "isolated worker could not be reaped".into());
        let (usage_artifact, codex_error_info, prior_error) = match &result {
            Ok(output) => (output.usage_artifact.clone(), None, None),
            Err(error) => {
                let failure = error.downcast_ref::<IsolatedToolWorkerFailure>();
                (
                    failure.and_then(|failure| failure.usage_artifact.clone()),
                    failure.and_then(|failure| failure.codex_error_info.clone()),
                    Some(format!("{error:#}")),
                )
            }
        };
        let mut message = format!("{cleanup_message}; runtime cannot accept further work");
        if let Some(prior_error) = prior_error {
            message.push_str(&format!("; execution: {prior_error}"));
        }
        if !stderr.is_empty() {
            message.push_str(&format!(
                "; diagnostic: {}",
                String::from_utf8_lossy(&stderr)
            ));
        }
        return Err(IsolatedToolWorkerFailure {
            message: redact_error(&request, &message),
            codex_error_info,
            usage_artifact,
        }
        .into());
    }
    result.map_err(|error| {
        if stderr.is_empty() {
            error
        } else {
            error.context(format!(
                "isolated worker diagnostic: {}",
                redact_error(&request, &String::from_utf8_lossy(&stderr))
            ))
        }
    })
}

/// What the worker process inherits from the runtime (`vars`): the helper baseline without the
/// locations the worker sets itself, plus the settings installed skill packs declare
/// ([`crate::skill_packs::pack_settings_environment`]). Never a credential.
fn worker_process_environment(
    packs: &[crate::skill_packs::InstalledPack],
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let vars: Vec<(OsString, OsString)> = vars.into_iter().collect();
    let mut environment: Vec<(OsString, OsString)> = vars
        .iter()
        .filter(|(key, _)| {
            key.to_str().is_some_and(|name| {
                PERSISTENT_HELPER_BASE_ENV_KEYS.contains(&name)
                    && ![
                        "HOME", "USER", "LOGNAME", "SHELL", "TZ", "TMPDIR", "TMP", "TEMP",
                    ]
                    .contains(&name)
            })
        })
        .cloned()
        .collect();
    environment.extend(crate::skill_packs::pack_settings_environment(packs, vars));
    environment
}

/// The variables the worker sets for itself and its tools after it starts: private locations,
/// the job's scoped credentials and identity, and the project's skill-pack folder.
fn worker_environment(
    request: &IsolatedToolWorkerRequest,
    state: &Path,
    workspace: &Path,
) -> HashMap<String, String> {
    let base = request.proxy_base_url.trim_end_matches('/');
    let mut environment = request.job_environment.clone();
    environment.extend(HashMap::from([
        (
            "HOME".into(),
            state.join("home").to_string_lossy().into_owned(),
        ),
        (
            "CODEX_HOME".into(),
            state.join("codex").to_string_lossy().into_owned(),
        ),
        (
            "TMPDIR".into(),
            state.join("tmp").to_string_lossy().into_owned(),
        ),
        (
            "TMP".into(),
            state.join("tmp").to_string_lossy().into_owned(),
        ),
        (
            "TEMP".into(),
            state.join("tmp").to_string_lossy().into_owned(),
        ),
        ("CODEX_API_KEY".into(), request.proxy_token.clone()),
        ("OPENAI_API_KEY".into(), request.proxy_token.clone()),
        ("OPENAI_BASE_URL".into(), format!("{base}/v1")),
        ("PROXY_BASE_URL".into(), base.into()),
        (
            "CONTROLLER_BASE_URL".into(),
            request.controller_base_url.clone(),
        ),
        ("PROJECT_ID".into(), request.project_id.to_string()),
        ("INSTAFY_PROJECT_ID".into(), request.project_id.to_string()),
        ("SPACE_ID".into(), request.project_id.to_string()),
        ("INSTAFY_SPACE_ID".into(), request.project_id.to_string()),
        ("CODEX_MAX_RUN_RETRIES".into(), "0".into()),
        (
            "GIT_CEILING_DIRECTORIES".into(),
            workspace.to_string_lossy().into_owned(),
        ),
        (
            "CODEX_RUN_TIMEOUT_SECONDS".into(),
            RUN_TIMEOUT.as_secs().to_string(),
        ),
    ]));
    if let Some(model) = &request.model {
        environment.insert("CODEX_MODEL".into(), model.clone());
    }
    if let Some(id) = request.conversation_id {
        environment.insert("CONVERSATION_ID".into(), id.to_string());
        environment.insert("INSTAFY_CONVERSATION_ID".into(), id.to_string());
    }
    if let Some(cache) = &request.cache_dir {
        environment.insert(
            crate::skill_packs::SKILL_PACK_CACHE_DIR_ENV.into(),
            cache.to_string_lossy().into_owned(),
        );
    }
    environment
}

fn encode_frame(value: &impl Serialize) -> Result<Vec<u8>> {
    let body = serde_json::to_vec(value)?;
    ensure!(
        body.len() <= MAX_FRAME_BYTES,
        "isolated worker IPC frame exceeds byte limit"
    );
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

fn partial_usage(mut artifact: Value, canceled: bool) -> Value {
    if let Some(calls) = artifact.get_mut("calls").and_then(Value::as_array_mut) {
        for call in calls {
            if !call.is_object() {
                continue;
            }
            call["outcome"] = Value::String(if canceled { "cancelled" } else { "error" }.into());
            call["usageStatus"] = Value::String(
                if call.get("usage").is_some() {
                    "partial"
                } else {
                    "unknown"
                }
                .into(),
            );
        }
    }
    artifact
}

async fn read_async_frame<T: serde::de::DeserializeOwned>(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
) -> Result<(T, usize)> {
    let size = reader
        .read_u32()
        .await
        .context("isolated worker IPC ended before a result")? as usize;
    ensure!(
        size > 0 && size <= MAX_FRAME_BYTES,
        "invalid isolated worker IPC frame size"
    );
    let mut body = vec![0u8; size];
    reader
        .read_exact(&mut body)
        .await
        .context("incomplete isolated worker IPC frame")?;
    Ok((
        serde_json::from_slice(&body).context("invalid isolated worker IPC frame")?,
        size + 4,
    ))
}

/// Called before Tokio is started. Private state is freshly created, not restored from a user's
/// auth/config home; secrets enter the child only after exec through the parent-owned pipe.
pub fn prepare_cli() -> Result<IsolatedToolWorkerRequest> {
    let mut size = [0u8; 4];
    let mut stdin = std::io::stdin().lock();
    stdin
        .read_exact(&mut size)
        .context("missing worker request")?;
    let size = u32::from_be_bytes(size) as usize;
    ensure!(
        size > 0 && size <= MAX_FRAME_BYTES,
        "invalid worker request size"
    );
    let mut body = vec![0u8; size];
    stdin
        .read_exact(&mut body)
        .context("incomplete worker request")?;
    let request: IsolatedToolWorkerRequest =
        serde_json::from_slice(&body).context("invalid worker request")?;
    request.validate()?;
    let state = std::fs::canonicalize(&request.state_dir)?;
    ensure!(
        std::fs::read_dir(&state)?.next().is_none(),
        "isolated worker state must be fresh"
    );
    for name in ["home", "codex", "tmp"] {
        std::fs::create_dir(state.join(name))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(state.join(name), std::fs::Permissions::from_mode(0o700))?;
        }
    }
    process_tree::prepare_child()?;
    let workspace = std::fs::canonicalize(&request.workspace_dir)?;
    let environment = worker_environment(&request, &state, &workspace);
    // Only the request names the skill-pack folder: a value inherited from the runtime never widens
    // the sandbox's writable folders (`codex::isolated_tool_worker_permissions`).
    if !environment.contains_key(crate::skill_packs::SKILL_PACK_CACHE_DIR_ENV) {
        // SAFETY: the one-shot CLI entry calls this before any thread is created.
        unsafe { std::env::remove_var(crate::skill_packs::SKILL_PACK_CACHE_DIR_ENV) };
    }
    for (key, value) in environment {
        // SAFETY: the one-shot CLI entry calls this before any thread is created.
        unsafe { std::env::set_var(key, value) };
    }
    Ok(request)
}

struct ProtocolWriter {
    bytes: usize,
}

impl ProtocolWriter {
    fn send(&mut self, frame: &WorkerFrame) -> Result<()> {
        let data = encode_frame(frame)?;
        self.bytes = self
            .bytes
            .checked_add(data.len())
            .context("worker output size overflow")?;
        ensure!(
            self.bytes <= MAX_OUTPUT_BYTES,
            "worker output exceeded its byte limit"
        );
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(&data)?;
        stdout.flush()?;
        Ok(())
    }
}

pub async fn run_cli(request: IsolatedToolWorkerRequest) -> Result<()> {
    let cancel = JobCancelSignal::new();
    let monitor_cancel = cancel.clone();
    let input = tokio::spawn(async move {
        // Parent pipe closure is cancellation too; a runtime crash must not leave a live model.
        let _ = read_async_frame::<ParentFrame>(&mut tokio::io::stdin()).await;
        monitor_cancel.cancel();
    });
    let writer = Arc::new(Mutex::new(ProtocolWriter { bytes: 0 }));
    let event_writer = writer.clone();
    let mut on_event = move |event: &Value| -> Result<()> {
        let frame =
            if event.get("type").and_then(Value::as_str) == Some("runtime.task_usage_snapshot") {
                WorkerFrame::Usage(
                    event
                        .get("artifact")
                        .context("missing worker usage snapshot")?
                        .clone(),
                )
            } else {
                WorkerFrame::Event(event.clone())
            };
        event_writer
            .lock()
            .map_err(|_| anyhow::anyhow!("worker protocol lock poisoned"))?
            .send(&frame)
    };
    let usage = TaskUsage::default();
    let client = CodexClient::new(CodexConfig {
        workspace_dir: request.workspace_dir.clone(),
    });
    let result = client
        .execute_with_options(
            &request.prompt,
            Some(&mut on_event),
            CodexRunOptions {
                isolated_tool_worker: true,
                usage_observer: Some(usage.call(UsagePhase::Main)),
                project_id: Some(request.project_id),
                job_id: Some(request.job_id),
                // Final actions can defer a human decision. Evidence gates in the
                // parent still require real commands/edits for ordinary results.
                disable_final_output_json_schema: false,
                allow_plain_text_final_fallback: false,
                plain_text_write_mode: false,
                require_first_tool_call: false,
                reasoning_effort: request.reasoning_effort.clone(),
                cancel_signal: Some(cancel.clone()),
                ..Default::default()
            },
        )
        .await;
    input.abort();
    let frame = match result {
        Ok(output) if !cancel.is_canceled() => WorkerFrame::Finished(IsolatedToolWorkerOutput {
            final_json: output.final_json,
            events: Vec::new(),
            usage_artifact: usage.artifact(),
        }),
        result => {
            let error = result.err();
            let info = error
                .as_ref()
                .and_then(|error| error.downcast_ref::<CodexExecutionError>())
                .and_then(|error| error.codex_error_info.clone());
            let message = if cancel.is_canceled() {
                "lease lost during isolated worker execution".to_string()
            } else {
                redact_error(
                    &request,
                    &error.map(|error| format!("{error:#}")).unwrap_or_default(),
                )
            };
            WorkerFrame::Failed(IsolatedToolWorkerFailure {
                message,
                codex_error_info: info,
                usage_artifact: usage.artifact(),
            })
        }
    };
    writer
        .lock()
        .map_err(|_| anyhow::anyhow!("worker protocol lock poisoned"))?
        .send(&frame)
}

fn redact_error(request: &IsolatedToolWorkerRequest, message: &str) -> String {
    let mut message = message.to_string();
    for value in std::iter::once(&request.proxy_token)
        .chain(request.controller_token.iter())
        .chain(request.job_environment.values())
    {
        if !value.is_empty() {
            message = message.replace(value, "[redacted]");
        }
    }
    message.chars().take(4_096).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_workers_refuse_platforms_without_a_wired_filesystem_sandbox() {
        assert!(ensure_supported_platform("linux").is_ok());
        assert!(ensure_supported_platform("macos").is_ok());
        for platform in ["windows", "freebsd", "unknown"] {
            assert!(ensure_supported_platform(platform).is_err());
        }
    }

    #[test]
    fn a_sandboxed_worker_request_never_carries_a_controller_token() {
        let scratch = tempfile::tempdir().unwrap();
        let workspace_dir = scratch.path().join("workspace");
        let state_dir = scratch.path().join("state");
        std::fs::create_dir_all(&workspace_dir).unwrap();
        std::fs::create_dir_all(&state_dir).unwrap();
        let request = IsolatedToolWorkerRequest {
            workspace_dir,
            state_dir,
            prompt: "inert".into(),
            project_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            conversation_id: None,
            proxy_base_url: "http://127.0.0.1:9".into(),
            proxy_token: "inert-proxy".into(),
            controller_base_url: "http://127.0.0.1:9".into(),
            controller_token: None,
            controller_token_scopes: Vec::new(),
            controller_token_expires_at: None,
            job_environment: HashMap::new(),
            model: None,
            reasoning_effort: None,
            cache_dir: None,
        };
        assert!(request.validate().is_ok());
        for with_authority in [
            IsolatedToolWorkerRequest {
                controller_token: Some("job-token".into()),
                ..request.clone()
            },
            IsolatedToolWorkerRequest {
                controller_token_scopes: vec!["prompt.execute".into()],
                ..request.clone()
            },
            IsolatedToolWorkerRequest {
                controller_token_expires_at: Some("2999-01-01T00:00:00Z".into()),
                ..request.clone()
            },
        ] {
            let error = with_authority.validate().unwrap_err().to_string();
            assert!(error.contains("never gets a controller token"), "{error}");
        }
    }

    #[test]
    fn private_workspace_rejects_repository_ancestors_and_git_pointer_files() {
        let scratch = tempfile::tempdir().unwrap();
        let workspace = scratch.path().join("nested/workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        assert!(ensure_no_repository_ancestry(&workspace).is_ok());
        let marker = scratch.path().join(".git");
        std::fs::write(&marker, "gitdir: inert-pointer-that-must-not-be-read").unwrap();
        assert!(ensure_no_repository_ancestry(&workspace).is_err());
        std::fs::remove_file(&marker).unwrap();
        std::fs::create_dir(&marker).unwrap();
        assert!(ensure_no_repository_ancestry(&workspace).is_err());
        std::fs::remove_dir(&marker).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(scratch.path().join("missing"), &marker).unwrap();
            assert!(ensure_no_repository_ancestry(&workspace).is_err());
        }
    }

    #[test]
    fn job_environment_cannot_replace_worker_authority_or_process_configuration() {
        for key in [
            "HOME",
            "PATH",
            "CODEX_HOME",
            "OPENAI_API_KEY",
            "controller_access_token",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "NODE_OPTIONS",
            "INSTAFY_SHARED_BROWSER_SESSION",
            "RUNTIME_ACCESS_TOKEN",
            "HTTPS_PROXY",
            "A=B",
        ] {
            assert!(!safe_job_environment_key(key), "{key}");
        }
        assert!(safe_job_environment_key("GITHUB_TOKEN"));
        assert!(safe_job_environment_key("INSTAFY_PROJECT_SECRET_INVENTORY"));
        assert!(safe_job_environment_key("PROJECT_TEST_SENTINEL"));
    }

    #[test]
    fn the_worker_inherits_declared_pack_settings_and_never_a_credential() {
        let root = tempfile::tempdir().unwrap();
        let mut pack = crate::skill_packs::load_pack(&crate::skill_packs::tests::make_pack(
            root.path(),
            "demo",
            true,
        ))
        .unwrap();
        pack.env = vec!["UW_*".into(), "INSTAFY_LOOKUP_*".into()];
        let vars = [
            ("PATH", "/bin"),
            ("HOME", "/runtime-home"),
            ("TMPDIR", "/runtime-tmp"),
            ("UW_OSRM", "https://osrm.example"),
            ("INSTAFY_LOOKUP_PROVIDERS", "{}"),
            ("UW_PRIVATE_KEY", "x"),
            ("INSTAFY_CACHE_DIR", "/another-project"),
            ("CONTROLLER_ACCESS_TOKEN", "x"),
            ("OPENAI_API_KEY", "x"),
            ("RUNTIME_ACCESS_TOKEN", "x"),
        ]
        .map(|(key, value)| (OsString::from(key), OsString::from(value)));
        let names = |packs: &[crate::skill_packs::InstalledPack]| -> Vec<String> {
            let mut names: Vec<String> = worker_process_environment(packs, vars.clone())
                .into_iter()
                .map(|(key, _)| key.into_string().unwrap())
                .collect();
            names.sort();
            names
        };
        assert_eq!(names(&[]), ["PATH"], "no pack: the helper baseline only");
        assert_eq!(
            names(std::slice::from_ref(&pack)),
            ["INSTAFY_LOOKUP_PROVIDERS", "PATH", "UW_OSRM"],
            "the pack's settings, never its credential-looking names or another folder"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_worker_path_reaches_pack_commands() {
        if crate::skill_packs::node_on_path().is_none() {
            return;
        }
        let packs_root = tempfile::tempdir().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let pack = crate::skill_packs::tests::pack_with_command(packs_root.path(), "demo", "demo");
        let packs = std::slice::from_ref(&pack);
        let runtime_path = std::env::var_os("PATH").unwrap();
        let prepared = crate::skill_packs::prepare_pack_bins_in(
            packs,
            Some(crate::skill_packs::tests::TEST_PACK_NODE),
            temp.path(),
            &runtime_path,
        );
        let dir = prepared.dir.as_ref().unwrap().path().to_path_buf();
        // What the worker process starts with, from the runtime's environment after startup.
        let vars = [
            (OsString::from("PATH"), prepared.path.clone()),
            (
                OsString::from("CONTROLLER_ACCESS_TOKEN"),
                OsString::from("x"),
            ),
        ];
        let environment = worker_process_environment(packs, vars);
        let path = environment
            .iter()
            .find(|(key, _)| key == "PATH")
            .map(|(_, value)| value.clone())
            .expect("the worker gets PATH");
        assert_eq!(std::env::split_paths(&path).last(), Some(dir.clone()));
        let output =
            crate::skill_packs::tests::run_with_path("command -v demo && demo --json", &path);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("{}\ndemo ran --json\n", dir.join("demo").display())
        );
    }

    #[test]
    fn only_the_request_names_the_skill_pack_folder_and_it_stays_apart() {
        let scratch = tempfile::tempdir().unwrap();
        let workspace_dir = scratch.path().join("workspace");
        let state_dir = scratch.path().join("state");
        let cache = scratch.path().join("cache");
        for dir in [&workspace_dir, &state_dir, &cache] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let request = IsolatedToolWorkerRequest {
            workspace_dir: workspace_dir.clone(),
            state_dir: state_dir.clone(),
            prompt: "inert".into(),
            project_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            conversation_id: None,
            proxy_base_url: "http://127.0.0.1:9".into(),
            proxy_token: "inert-proxy".into(),
            controller_base_url: "http://127.0.0.1:9".into(),
            controller_token: None,
            controller_token_scopes: Vec::new(),
            controller_token_expires_at: None,
            job_environment: HashMap::new(),
            model: None,
            reasoning_effort: None,
            cache_dir: Some(cache.clone()),
        };
        assert!(request.validate().is_ok());
        let environment = worker_environment(&request, &state_dir, &workspace_dir);
        assert_eq!(
            environment
                .get(crate::skill_packs::SKILL_PACK_CACHE_DIR_ENV)
                .map(String::as_str),
            Some(cache.to_string_lossy().as_ref())
        );
        assert_eq!(
            environment["HOME"],
            state_dir.join("home").to_string_lossy()
        );
        let without = IsolatedToolWorkerRequest {
            cache_dir: None,
            ..request.clone()
        };
        assert!(
            !worker_environment(&without, &state_dir, &workspace_dir)
                .contains_key(crate::skill_packs::SKILL_PACK_CACHE_DIR_ENV)
        );
        for bad in [
            workspace_dir.join("cache"),
            state_dir.clone(),
            PathBuf::from("relative/cache"),
            scratch.path().to_path_buf(),
        ] {
            let _ = std::fs::create_dir_all(workspace_dir.join("cache"));
            let error = IsolatedToolWorkerRequest {
                cache_dir: Some(bad.clone()),
                ..request.clone()
            }
            .validate()
            .unwrap_err()
            .to_string();
            assert!(error.contains("cache folder"), "{bad:?}: {error}");
        }
        // a job's own environment can never name it
        let mut job_environment = HashMap::new();
        job_environment.insert(
            crate::skill_packs::SKILL_PACK_CACHE_DIR_ENV.to_string(),
            "/elsewhere".to_string(),
        );
        assert!(
            IsolatedToolWorkerRequest {
                job_environment,
                ..request
            }
            .validate()
            .is_err()
        );
    }

    #[tokio::test]
    async fn poisoned_or_oversized_frames_are_rejected_before_allocating_body() {
        for bytes in [
            vec![0, 0, 0, 0],
            ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes().to_vec(),
            b"not a frame".to_vec(),
        ] {
            assert!(
                read_async_frame::<WorkerFrame>(&mut bytes.as_slice())
                    .await
                    .is_err()
            );
        }
        let frame = encode_frame(&WorkerFrame::Event(serde_json::json!({"type":"tool"}))).unwrap();
        let (decoded, _) = read_async_frame::<WorkerFrame>(&mut frame.as_slice())
            .await
            .unwrap();
        assert!(matches!(decoded, WorkerFrame::Event(_)));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn abrupt_worker_exit_preserves_received_usage_as_partial() {
        use crate::task_usage::{UsageCounts, UsageOutcome};
        use std::os::unix::fs::PermissionsExt;

        let scratch = tempfile::tempdir().unwrap();
        let workspace_dir = scratch.path().join("workspace");
        let state_dir = scratch.path().join("state");
        std::fs::create_dir(&workspace_dir).unwrap();
        std::fs::create_dir(&state_dir).unwrap();
        let usage = TaskUsage::default();
        let observation = usage.call(UsagePhase::Main).start_attempt(1);
        observation.observe_response(
            "inert-response",
            Some(UsageCounts {
                input_tokens: 5,
                output_tokens: 2,
                total_tokens: 7,
                ..Default::default()
            }),
        );
        observation.completed();
        observation.finish(UsageOutcome::Success);
        let snapshot = scratch.path().join("snapshot");
        std::fs::write(
            &snapshot,
            encode_frame(&WorkerFrame::Usage(usage.artifact().unwrap())).unwrap(),
        )
        .unwrap();
        let request = IsolatedToolWorkerRequest {
            workspace_dir,
            state_dir,
            // Exceed the pipe buffer so the fixture must consume the entire request.
            prompt: "inert fixture ".repeat(16 * 1024),
            project_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            conversation_id: None,
            proxy_base_url: "http://127.0.0.1:9".into(),
            proxy_token: "inert-proxy".into(),
            controller_base_url: "http://127.0.0.1:9".into(),
            controller_token: None,
            controller_token_scopes: Vec::new(),
            controller_token_expires_at: None,
            job_environment: HashMap::new(),
            model: None,
            reasoning_effort: None,
            cache_dir: None,
        };
        let request_bytes = encode_frame(&request).unwrap().len();
        let program = scratch.path().join("worker");
        let quoted_snapshot = snapshot.to_string_lossy().replace('\'', "'\"'\"'");
        // The real worker reads its request before producing output. Without this
        // handshake, an early fixture exit can break the parent's request write
        // before it reads any usage, instead of exercising EOF after received usage.
        // bs=1 avoids platform-specific short-block behavior in dd's count limit.
        std::fs::write(
            &program,
            format!(
                "#!/bin/sh\n/bin/dd bs=1 count={request_bytes} of=/dev/null 2>/dev/null\nexec /bin/cat '{quoted_snapshot}'\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let error = run_with_program(&program, request, &mut |_| Ok(()), JobCancelSignal::new())
            .await
            .unwrap_err();
        let failure = error.downcast_ref::<IsolatedToolWorkerFailure>().unwrap();
        assert!(
            failure.message.contains("IPC ended before a result"),
            "unexpected worker failure: {}",
            failure.message
        );
        let receipt = failure.usage_artifact.as_ref().unwrap();
        assert_eq!(receipt["calls"][0]["usage"]["total_tokens"], 7);
        assert_eq!(receipt["calls"][0]["usageStatus"], "partial");
        assert_eq!(receipt["calls"][0]["outcome"], "error");
        assert!(runtime_reuse_is_safe());
    }
}
