use std::collections::{HashMap, HashSet};
use std::future::pending;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Notify;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{MissedTickBehavior, interval, sleep};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::agent_executor::AgentExecutor;
use crate::config::Config;
use crate::controller::{
    AgentSecretInventoryItem, ControllerClient, JobSecrets, LeaseError, LeaseJob, Registration,
};
use crate::job_cancel::JobCancelSignal;
use crate::jobs::{JobExecution, JobFailureWithArtifacts, JobProcessor};
use crate::origin::{OriginLaunchOverrides, OriginService};
use crate::personal_browser::validate_personal_browser_job_capability;
use crate::tunnels::{TunnelLifecycle, request_tunnel_assignment};

static JOB_PROCESS_ENV_LOCK: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));

pub struct RuntimeAgent {
    config: Config,
    shutdown: ShutdownSignal,
    secret_env_keys: Arc<Mutex<HashSet<String>>>,
}

/// A sticky, broadcast shutdown signal.
///
/// `Notify::notify_waiters` alone is edge-triggered: a signal received while the
/// lease loop is executing a job can be lost before the loop waits again. This
/// wrapper records cancellation so every current and future waiter observes it.
#[derive(Clone, Debug, Default)]
pub struct ShutdownSignal {
    cancelled: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl ShutdownSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

struct HeartbeatTask {
    stop_signal: Arc<Notify>,
    handle: JoinHandle<()>,
}

impl HeartbeatTask {
    fn spawn(
        client: Arc<ControllerClient>,
        registration: Registration,
        job_id: Uuid,
        interval_seconds: u64,
        lease_lost_signal: Option<JobCancelSignal>,
    ) -> Self {
        let stop_signal = Arc::new(Notify::new());
        let stop_listener = stop_signal.clone();
        let lease_lost_signal = lease_lost_signal.clone();
        let handle = tokio::spawn(async move {
            // `interval_seconds` is already derived from the controller heartbeat lease (clamped in
            // the caller). Keep heartbeats frequent enough to detect lease loss promptly and keep
            // the controller-side runtime `last_seen_at` fresh (important for stale-runtime sweeps).
            let interval_duration = Duration::from_secs(interval_seconds.max(5));
            let mut ticker = interval(interval_duration);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

            let mut skip_first = true;
            loop {
                tokio::select! {
                    _ = stop_listener.notified() => {
                        break;
                    }
                    _ = ticker.tick() => {
                        if skip_first {
                            skip_first = false;
                            continue;
                        }

                        if let Err(error) = client.heartbeat(&registration, job_id).await {
                            let message = error.to_string();
                            if message.contains("heartbeat lease lost") {
                                warn!(job_id = %job_id, %message, "job lease lost during heartbeat; stopping job");
                                if let Some(signal) = lease_lost_signal.as_ref() {
                                    signal.cancel();
                                }
                                break;
                            }
                            warn!(?error, job_id = %job_id, "periodic heartbeat failed");
                        }
                    }
                }
            }
        });

        Self {
            stop_signal,
            handle,
        }
    }

    async fn shutdown(self) {
        self.stop_signal.notify_waiters();
        if let Err(error) = self.handle.await {
            if !error.is_cancelled() {
                warn!(?error, "heartbeat task ended unexpectedly");
            }
        }
    }
}

struct SecretsRefreshTask {
    stop_signal: Arc<Notify>,
    handle: JoinHandle<()>,
}

impl SecretsRefreshTask {
    fn spawn(
        client: Arc<ControllerClient>,
        registration: Registration,
        job_id: Uuid,
        interval_seconds: u64,
        secret_env_keys: Arc<Mutex<HashSet<String>>>,
    ) -> Self {
        let stop_signal = Arc::new(Notify::new());
        let stop_listener = stop_signal.clone();
        let handle = tokio::spawn(async move {
            if interval_seconds == 0 {
                return;
            }

            let interval_duration = Duration::from_secs(interval_seconds.max(5));
            let mut ticker = interval(interval_duration);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

            let mut skip_first = true;
            loop {
                tokio::select! {
                    _ = stop_listener.notified() => {
                        break;
                    }
                    _ = ticker.tick() => {
                        if skip_first {
                            skip_first = false;
                            continue;
                        }

                        match client.fetch_job_secrets(&registration, job_id, false).await {
                            Ok(secrets) => {
                                apply_job_secrets(&secret_env_keys, &secrets);
                                debug!(
                                    job_id = %job_id,
                                    secret_count = secrets.env.len(),
                                    inventory_count = secrets.inventory.len(),
                                    "refreshed job secrets"
                                );
                            }
                            Err(error) => {
                                warn!(?error, job_id = %job_id, "failed to refresh job secrets");
                            }
                        }
                    }
                }
            }
        });

        Self {
            stop_signal,
            handle,
        }
    }

    async fn shutdown(self) {
        self.stop_signal.notify_waiters();
        if let Err(error) = self.handle.await {
            if !error.is_cancelled() {
                warn!(?error, "secrets refresh task ended unexpectedly");
            }
        }
    }
}

impl RuntimeAgent {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            shutdown: ShutdownSignal::new(),
            secret_env_keys: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn shutdown_handle(&self) -> ShutdownSignal {
        self.shutdown.clone()
    }

    pub async fn run(self) {
        if let Err(error) = self.run_inner().await {
            error!(?error, "runtime agent terminated with error");
        }
    }

    async fn run_inner(self) -> Result<()> {
        let RuntimeAgent {
            config,
            shutdown,
            secret_env_keys,
        } = self;
        let config = Arc::new(config);

        let client = Arc::new(ControllerClient::new(&config)?);
        let executor = Arc::new(AgentExecutor::new(config.clone()));

        Self::run_registration_loop(
            config.clone(),
            client,
            executor,
            shutdown.clone(),
            secret_env_keys,
        )
        .await
    }

    async fn run_registration_loop(
        config: Arc<Config>,
        client: Arc<ControllerClient>,
        executor: Arc<AgentExecutor>,
        shutdown: ShutdownSignal,
        secret_env_keys: Arc<Mutex<HashSet<String>>>,
    ) -> Result<()> {
        loop {
            match Self::register_and_process(
                config.clone(),
                client.clone(),
                executor.clone(),
                shutdown.clone(),
                secret_env_keys.clone(),
            )
            .await
            {
                Ok(true) => {
                    info!("registration loop signalled shutdown");
                    return Ok(());
                }
                Ok(false) => {
                    info!("registration loop completed gracefully");
                }
                Err(error) => {
                    warn!(?error, "registration loop failed; retrying after delay");
                }
            }
            if Self::sleep_or_shutdown(Duration::from_secs(5), shutdown.clone()).await {
                info!("shutdown requested; exiting registration retry loop");
                return Ok(());
            }
        }
    }

    async fn register_and_process(
        config: Arc<Config>,
        client: Arc<ControllerClient>,
        executor: Arc<AgentExecutor>,
        shutdown: ShutdownSignal,
        secret_env_keys: Arc<Mutex<HashSet<String>>>,
    ) -> Result<bool> {
        let registration = client
            .register_runtime(&config)
            .await
            .context("failed to register runtime")?;

        // Flag-gated (INSTAFY_BROWSER_PROFILE_PERSIST): restore the durable
        // browser profile onto the ephemeral disk and launch Chromium against
        // it before we serve any jobs. No-op on the default path (Chromium is
        // launched by entrypoint.sh there and this returns immediately).
        crate::browser_profile::maybe_restore_and_launch(client.as_ref(), &registration).await;

        let tunnel_assignment = match request_tunnel_assignment(&config, &registration).await {
            Ok(result) => result,
            Err(error) => {
                warn!(
                    ?error,
                    "failed to request tunnel assignment; continuing without tunnel"
                );
                None
            }
        };

        let origin_controller_token = registration
            .runtime_token
            .as_ref()
            .map(|token| token.trim())
            .filter(|token| !token.is_empty())
            .map(ToOwned::to_owned);
        let origin_overrides = if tunnel_assignment.is_some() || origin_controller_token.is_some() {
            Some(OriginLaunchOverrides {
                tunnel: tunnel_assignment
                    .as_ref()
                    .map(|assignment| assignment.snapshot()),
                controller_token: origin_controller_token.clone(),
            })
        } else {
            None
        };

        let mut origin_service =
            OriginService::try_start(config.clone(), origin_overrides.clone()).await?;
        let presence_metadata = origin_service
            .as_ref()
            .and_then(|service| service.presence_metadata_handle());

        let mut tunnel_lifecycle = match tunnel_assignment.clone() {
            Some(assignment) => {
                match TunnelLifecycle::start(config.clone(), assignment, presence_metadata.clone())
                    .await
                {
                    Ok(handle) => Some(handle),
                    Err(error) => {
                        warn!(
                            ?error,
                            "failed to launch tunnel process; continuing without tunnel"
                        );
                        None
                    }
                }
            }
            None => None,
        };

        // If we failed to launch the tunnel, re-register origin without advertising the tunnel URL.
        // Otherwise the controller hands out tunnel endpoints that return 502 (because no tunnel is
        // actually connected), breaking local desktop/CLI flows.
        if should_restart_origin_after_failed_tunnel(
            tunnel_assignment.is_some(),
            tunnel_lifecycle.is_some(),
            origin_overrides.is_some(),
        ) {
            if let Some(service) = origin_service.as_mut() {
                service.shutdown().await;
            }
            let token_only_overrides =
                origin_controller_token
                    .clone()
                    .map(|token| OriginLaunchOverrides {
                        tunnel: None,
                        controller_token: Some(token),
                    });
            origin_service = OriginService::try_start(config.clone(), token_only_overrides).await?;
        }

        let tunnel_refresh = tunnel_lifecycle
            .as_ref()
            .map(|lifecycle| lifecycle.refresh_notifier());

        // Snapshot the profile periodically during the session so an abrupt
        // SIGKILL does not lose a mid-session login (the shutdown snapshot below
        // only runs on a clean stop). No-op unless persistence is enabled.
        // Spawned here, after browser launch + origin/tunnel setup, so no `?`
        // early-return between the spawn and the abort can leak it.
        let periodic_snapshots = tokio::spawn(crate::browser_profile::run_periodic_snapshots(
            client.clone(),
            registration.clone(),
            shutdown.clone(),
        ));

        let lease_result = Self::lease_loop(
            client.clone(),
            executor,
            &registration,
            shutdown.clone(),
            tunnel_refresh,
            secret_env_keys,
        )
        .await;

        // Stop periodic snapshots before the clean shutdown snapshot so they do
        // not read/upload the live profile concurrently, and so an error path
        // does not leak the task.
        periodic_snapshots.abort();
        let _ = periodic_snapshots.await;

        let shutdown_triggered = lease_result?;

        if let Some(lifecycle) = tunnel_lifecycle.as_mut() {
            lifecycle.shutdown().await;
        }

        if let Some(service) = origin_service.as_mut() {
            service.shutdown().await;
        }

        if shutdown_triggered {
            // Flag-gated: snapshot the browser profile back to the controller
            // before we tear the runtime down, so the next runtime restores it.
            crate::browser_profile::maybe_snapshot(client.as_ref(), &registration).await;

            if should_self_disposition_runtime_on_shutdown(
                config.parent_dispositions_runtime_on_shutdown,
            ) {
                if let Err(error) = client
                    .stop_runtime(&registration, Some("agent_shutdown"))
                    .await
                {
                    warn!(?error, "failed to stop runtime during shutdown");
                }
            } else {
                info!("runtime disposition deferred to parent after desktop process-tree shutdown");
            }
        } else {
            info!("tunnel refresh requested; keeping runtime registered");
        }

        Ok(shutdown_triggered)
    }

    async fn lease_loop(
        client: Arc<ControllerClient>,
        executor: Arc<AgentExecutor>,
        registration: &Registration,
        shutdown: ShutdownSignal,
        refresh: Option<Arc<Notify>>,
        secret_env_keys: Arc<Mutex<HashSet<String>>>,
    ) -> Result<bool> {
        let poll_interval = client.poll_interval();
        let heartbeat_seconds = client.heartbeat_seconds().max(30);

        loop {
            let jobs = tokio::select! {
                _ = shutdown.cancelled() => {
                    info!("shutdown requested; exiting lease loop");
                    return Ok(true);
                }
                _ = Self::wait_for_refresh(refresh.clone()) => {
                    info!("tunnel refresh requested; exiting lease loop");
                    return Ok(false);
                }
                result = client.lease_once(registration) => result,
            };

            let jobs = match jobs {
                Ok(jobs) => jobs,
                Err(LeaseError::Unauthorized) => {
                    warn!("lease request returned 401; agent token expired. Re-registering.");
                    return Err(anyhow!("agent token expired"));
                }
                Err(LeaseError::Other(error)) => {
                    warn!(?error, "lease request failed; retrying");
                    match Self::sleep_or_signal(poll_interval, shutdown.clone(), refresh.clone())
                        .await
                    {
                        LoopSignal::Shutdown => {
                            info!("shutdown requested during retry backoff; exiting lease loop");
                            return Ok(true);
                        }
                        LoopSignal::Refresh => {
                            info!(
                                "tunnel refresh requested during retry backoff; exiting lease loop"
                            );
                            return Ok(false);
                        }
                        LoopSignal::Completed => {}
                    }
                    continue;
                }
            };

            if jobs.is_empty() {
                debug!("lease returned no jobs");
                match Self::sleep_or_signal(poll_interval, shutdown.clone(), refresh.clone()).await
                {
                    LoopSignal::Shutdown => {
                        info!("shutdown requested during idle backoff; exiting lease loop");
                        return Ok(true);
                    }
                    LoopSignal::Refresh => {
                        info!("tunnel refresh requested during idle backoff; exiting lease loop");
                        return Ok(false);
                    }
                    LoopSignal::Completed => {}
                }
                continue;
            }

            Self::handle_job_batch(
                client.clone(),
                executor.clone(),
                registration,
                jobs,
                heartbeat_seconds,
                secret_env_keys.clone(),
            )
            .await?;

            // Sleep briefly before requesting next job batch to avoid hot-looping.
            match Self::sleep_or_signal(
                Duration::from_millis(500),
                shutdown.clone(),
                refresh.clone(),
            )
            .await
            {
                LoopSignal::Shutdown => {
                    info!("shutdown requested during post-job backoff; exiting lease loop");
                    return Ok(true);
                }
                LoopSignal::Refresh => {
                    info!("tunnel refresh requested during post-job backoff; exiting lease loop");
                    return Ok(false);
                }
                LoopSignal::Completed => {}
            }
        }
    }

    async fn handle_job_batch(
        client: Arc<ControllerClient>,
        executor: Arc<AgentExecutor>,
        registration: &Registration,
        jobs: Vec<LeaseJob>,
        heartbeat_seconds: u32,
        secret_env_keys: Arc<Mutex<HashSet<String>>>,
    ) -> Result<()> {
        let processor = executor.processor();
        if should_run_batch_as_parallel_direct_write_group(&processor, registration, &jobs) {
            info!(
                job_count = jobs.len(),
                "handling exact write-scoped leased job batch in parallel on one runtime"
            );
            let mut tasks = JoinSet::new();
            for job in jobs {
                info!(job_id = %job.id, intent = ?job.intent, "leased job");
                let client = client.clone();
                let executor = executor.clone();
                let registration = registration.clone();
                let secret_env_keys = secret_env_keys.clone();
                tasks.spawn(async move {
                    Self::handle_job(
                        client,
                        executor,
                        &registration,
                        job,
                        heartbeat_seconds,
                        secret_env_keys,
                    )
                    .await
                });
            }

            let mut first_error: Option<anyhow::Error> = None;
            while let Some(result) = tasks.join_next().await {
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        if first_error.is_none() {
                            first_error = Some(error);
                        }
                    }
                    Err(error) => {
                        if first_error.is_none() {
                            first_error = Some(anyhow!("concurrent job task failed: {error}"));
                        }
                    }
                }
            }

            if let Some(error) = first_error {
                return Err(error);
            }
            return Ok(());
        }

        if should_run_batch_as_read_only_group(&jobs) {
            info!(
                job_count = jobs.len(),
                "handling read-only leased job batch; env-sensitive execution is serialized per runtime"
            );
            let mut tasks = JoinSet::new();
            for job in jobs {
                info!(job_id = %job.id, intent = ?job.intent, "leased job");
                let client = client.clone();
                let executor = executor.clone();
                let registration = registration.clone();
                let secret_env_keys = secret_env_keys.clone();
                tasks.spawn(async move {
                    Self::handle_job(
                        client,
                        executor,
                        &registration,
                        job,
                        heartbeat_seconds,
                        secret_env_keys,
                    )
                    .await
                });
            }

            let mut first_error: Option<anyhow::Error> = None;
            while let Some(result) = tasks.join_next().await {
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        if first_error.is_none() {
                            first_error = Some(error);
                        }
                    }
                    Err(error) => {
                        if first_error.is_none() {
                            first_error = Some(anyhow!("concurrent job task failed: {error}"));
                        }
                    }
                }
            }

            if let Some(error) = first_error {
                return Err(error);
            }
            return Ok(());
        }

        for job in jobs {
            info!(job_id = %job.id, intent = ?job.intent, "leased job");
            Self::handle_job(
                client.clone(),
                executor.clone(),
                registration,
                job,
                heartbeat_seconds,
                secret_env_keys.clone(),
            )
            .await?;
        }

        Ok(())
    }

    async fn handle_job(
        client: Arc<ControllerClient>,
        executor: Arc<AgentExecutor>,
        registration: &Registration,
        job: LeaseJob,
        heartbeat_seconds: u32,
        secret_env_keys: Arc<Mutex<HashSet<String>>>,
    ) -> Result<()> {
        // Fail Personal Browser jobs before heartbeats, secrets, or any executor
        // path can make a hosted/shared browser fallback possible.
        if let Err(error) = validate_personal_browser_job_capability(&job.payload, job.project_id) {
            let message = error.to_string();
            warn!(
                job_id = %job.id,
                %message,
                "rejecting Personal Browser job without a complete capability"
            );
            if let Err(report_error) = client.fail_job(registration, job.id, &message, None).await {
                warn!(
                    ?report_error,
                    job_id = %job.id,
                    "failed to report Personal Browser capability rejection"
                );
            }
            return Ok(());
        }

        let mut periodic_heartbeat: Option<HeartbeatTask> = None;
        let mut periodic_secrets_refresh: Option<SecretsRefreshTask> = None;
        let lease_lost_signal = JobCancelSignal::new();
        if heartbeat_seconds > 0 {
            // Keep the heartbeat loop alive even if the initial heartbeat fails (network hiccup,
            // controller restart, etc). Otherwise the job can lose its lease and get requeued while
            // the runtime is still executing a long-running command.
            let interval_secs = (heartbeat_seconds / 6).clamp(5, 15) as u64;
            periodic_heartbeat = Some(HeartbeatTask::spawn(
                client.clone(),
                registration.clone(),
                job.id,
                interval_secs,
                Some(lease_lost_signal.clone()),
            ));

            if let Err(error) = client
                .heartbeat(registration, job.id)
                .await
                .context("heartbeat during job handling failed")
            {
                warn!(?error, job_id = %job.id, "heartbeat failed");
            }
        }

        // Job secrets, controller access tokens, and Codex proxy credentials are process-wide
        // environment variables today. Start heartbeats first so queued sibling jobs keep their
        // lease, then serialize the env-sensitive part of each job inside one runtime process.
        // Exact write-scoped direct worker lanes use per-job proxy config and no process env
        // mutation, so one runtime can safely execute disjoint owned-path lanes concurrently.
        let parallel_direct_write = executor
            .processor()
            .can_run_parallel_direct_write_scoped_worker(registration, &job);
        let _job_process_env_guard = if parallel_direct_write {
            None
        } else {
            Some(JOB_PROCESS_ENV_LOCK.lock().await)
        };
        if lease_lost_signal.is_canceled() {
            info!(
                job_id = %job.id,
                "job lease was lost before env-sensitive execution; skipping job"
            );
            if let Some(task) = periodic_heartbeat.take() {
                task.shutdown().await;
            }
            return Ok(());
        }

        if !parallel_direct_write {
            match client.fetch_job_secrets(registration, job.id, true).await {
                Ok(secrets) => {
                    apply_job_secrets(&secret_env_keys, &secrets);
                    debug!(
                        job_id = %job.id,
                        secret_count = secrets.env.len(),
                        inventory_count = secrets.inventory.len(),
                        "applied job secrets"
                    );
                }
                Err(error) => {
                    warn!(?error, job_id = %job.id, "failed to fetch job secrets");
                }
            }
        }

        let secrets_refresh_seconds = resolve_secrets_refresh_interval_seconds();
        if secrets_refresh_seconds > 0 && !parallel_direct_write {
            periodic_secrets_refresh = Some(SecretsRefreshTask::spawn(
                client.clone(),
                registration.clone(),
                job.id,
                secrets_refresh_seconds,
                secret_env_keys.clone(),
            ));
        }

        let mode = execution_mode(&job);

        match mode {
            ExecutionMode::Apply => {
                if let Some(message) = write_scope_coordination_required_message(&job) {
                    warn!(
                        job_id = %job.id,
                        message = %message,
                        "completing coordination-required write-scope job without edits"
                    );
                    Self::complete_job(
                        &client,
                        registration,
                        &job,
                        JobExecution {
                            summary: message,
                            suggested_replies: Vec::new(),
                            provider: "write-scope-guardrail".to_string(),
                            artifacts: vec![json!({
                                "kind": "write-scope/coordination-required",
                            })],
                            credit_snapshot: None,
                            provider_conversation_state: None,
                            messages: Vec::new(),
                            messages_streamed: false,
                            final_messages: Vec::new(),
                        },
                    )
                    .await;
                } else {
                    let execution_result = if parallel_direct_write {
                        executor
                            .run_parallel_direct_write_scoped_with_progress(
                                client.clone(),
                                registration,
                                &job,
                                Some(lease_lost_signal.clone()),
                            )
                            .await
                    } else {
                        executor
                            .run_apply_with_progress(
                                client.clone(),
                                registration,
                                &job,
                                Some(lease_lost_signal.clone()),
                            )
                            .await
                    };
                    match execution_result {
                        Ok(execution) => {
                            Self::complete_job(&client, registration, &job, execution).await;
                        }
                        Err(error) => {
                            let lease_lost = error.chain().any(|cause| {
                                cause
                                    .to_string()
                                    .to_ascii_lowercase()
                                    .contains("lease lost")
                            });
                            if lease_lost {
                                info!(job_id = %job.id, "job cancelled; skipping completion");
                                executor.processor().cleanup_after_lease_lost(&job).await;
                                if let Some(task) = periodic_heartbeat.take() {
                                    task.shutdown().await;
                                }
                                if let Some(task) = periodic_secrets_refresh.take() {
                                    task.shutdown().await;
                                }
                                if !parallel_direct_write {
                                    let empty = JobSecrets {
                                        env: HashMap::new(),
                                        inventory: Vec::new(),
                                    };
                                    apply_job_secrets(&secret_env_keys, &empty);
                                }
                                return Ok(());
                            }
                            let failure_with_artifacts =
                                error.downcast_ref::<JobFailureWithArtifacts>();
                            let chain: Vec<String> =
                                error.chain().map(|cause| cause.to_string()).collect();
                            let message = failure_with_artifacts
                                .map(|failure| failure.message.clone())
                                .or_else(|| chain.first().cloned())
                                .unwrap_or_else(|| error.to_string());
                            warn!(
                                ?error,
                                error_chain = %chain.join(" -> "),
                                display_error = %message,
                                job_id = %job.id,
                                "apply job failed"
                            );
                            let telemetry_payload = json!({
                                "kind": "telemetry.error",
                                "level": "error",
                                "message": message,
                                "projectId": job.project_id.map(|value| value.to_string()),
                                "runId": job.run_id.map(|value| value.to_string()),
                                "runtimeId": registration.runtime_id.to_string(),
                                "metadata": {
                                    "jobId": job.id.to_string(),
                                    "errorChain": chain
                                }
                            });
                            if let Err(telemetry_error) =
                                client.post_telemetry(telemetry_payload).await
                            {
                                warn!(
                                    ?telemetry_error,
                                    job_id = %job.id,
                                    "failed to report telemetry for job error"
                                );
                            }
                            let failure_result = match failure_with_artifacts {
                                Some(failure) => {
                                    client
                                        .fail_job_with_artifacts(
                                            registration,
                                            job.id,
                                            &message,
                                            &failure.artifacts,
                                            None,
                                        )
                                        .await
                                }
                                None => client.fail_job(registration, job.id, &message, None).await,
                            };
                            if let Err(report_error) = failure_result {
                                warn!(
                                    ?report_error,
                                    job_id = %job.id,
                                    "failed to report job failure"
                                );
                            }
                        }
                    }
                }
            }
            other => {
                warn!(job_id = %job.id, mode = %other.as_str(), "execution mode not supported yet");
                let message = format!("execution mode '{}' is not yet implemented", other.as_str());
                if let Err(report_error) =
                    client.fail_job(registration, job.id, &message, None).await
                {
                    warn!(
                        ?report_error,
                        job_id = %job.id,
                        "failed to report unsupported execution mode"
                    );
                }
            }
        }

        if let Some(task) = periodic_heartbeat {
            task.shutdown().await;
        }

        if let Some(task) = periodic_secrets_refresh {
            task.shutdown().await;
        }

        if !parallel_direct_write {
            let empty = JobSecrets {
                env: HashMap::new(),
                inventory: Vec::new(),
            };
            apply_job_secrets(&secret_env_keys, &empty);
        }

        Ok(())
    }

    async fn complete_job(
        client: &ControllerClient,
        registration: &Registration,
        job: &LeaseJob,
        execution: JobExecution,
    ) {
        if !execution.messages_streamed {
            for (index, message) in execution.messages.iter().enumerate() {
                if let Err(error) = client
                    .append_job_message(
                        registration,
                        job.id,
                        &message.content,
                        message.message_type.as_deref(),
                        message.metadata.as_ref(),
                    )
                    .await
                {
                    warn!(
                        ?error,
                        job_id = %job.id,
                        attempt = index + 1,
                        "failed to report interim agent message"
                    );
                }
            }
        }

        for (index, message) in execution.final_messages.iter().enumerate() {
            if let Err(error) = client
                .append_job_message(
                    registration,
                    job.id,
                    &message.content,
                    message.message_type.as_deref(),
                    message.metadata.as_ref(),
                )
                .await
            {
                warn!(
                    ?error,
                    job_id = %job.id,
                    attempt = index + 1,
                    "failed to report final agent message"
                );
            }
        }

        match client
            .complete_job(
                registration,
                job.id,
                &execution.summary,
                &execution.artifacts,
                execution.proxy_metadata(),
            )
            .await
        {
            Ok(()) => {
                info!(
                    job_id = %job.id,
                    provider = execution.provider,
                    "completed job"
                );
            }
            Err(error) => {
                warn!(?error, job_id = %job.id, "failed to report job completion");
            }
        }
    }
}

fn should_self_disposition_runtime_on_shutdown(parent_dispositions_runtime: bool) -> bool {
    !parent_dispositions_runtime
}

#[derive(Debug, Clone, Copy)]
enum ExecutionMode {
    Apply,
    PlanOnly,
    ApprovalRequired,
}

impl ExecutionMode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Apply => "apply",
            Self::PlanOnly => "plan_only",
            Self::ApprovalRequired => "approval_required",
        }
    }
}

fn execution_mode(job: &LeaseJob) -> ExecutionMode {
    job.payload
        .get("metadata")
        .and_then(|metadata| metadata.get("execution_mode"))
        .and_then(|mode| mode.as_str())
        .map(|value| match value.to_lowercase().as_str() {
            "plan_only" => ExecutionMode::PlanOnly,
            "approval_required" => ExecutionMode::ApprovalRequired,
            _ => ExecutionMode::Apply,
        })
        .unwrap_or(ExecutionMode::Apply)
}

fn should_run_batch_as_read_only_group(jobs: &[LeaseJob]) -> bool {
    jobs.len() > 1
        && jobs.iter().all(|job| {
            write_scope_mode(job).as_deref() == Some("read_only")
                && !job_requests_runtime_spread(job)
        })
}

fn should_run_batch_as_parallel_direct_write_group(
    processor: &JobProcessor,
    registration: &Registration,
    jobs: &[LeaseJob],
) -> bool {
    if jobs.len() <= 1 {
        return false;
    }

    let mut owned_paths: HashSet<String> = HashSet::new();
    jobs.iter().all(|job| {
        if job_requests_runtime_spread(job)
            || !processor.can_run_parallel_direct_write_scoped_worker(registration, job)
        {
            return false;
        }
        let Some(paths) = processor.parallel_direct_write_scope_paths(job) else {
            return false;
        };
        for path in paths {
            if owned_paths
                .iter()
                .any(|existing| direct_write_scopes_conflict(existing, &path))
            {
                return false;
            }
            if !owned_paths.insert(path) {
                return false;
            }
        }
        true
    })
}

fn direct_write_scopes_conflict(left: &str, right: &str) -> bool {
    left == right
        || direct_write_scope_has_parent(left, right)
        || direct_write_scope_has_parent(right, left)
}

fn direct_write_scope_has_parent(path: &str, parent: &str) -> bool {
    let parent = parent.trim_end_matches("/**");
    path.len() > parent.len()
        && path.starts_with(parent)
        && path.as_bytes().get(parent.len()) == Some(&b'/')
}

fn job_requests_runtime_spread(job: &LeaseJob) -> bool {
    let Some(routing) = job
        .payload
        .get("metadata")
        .and_then(|metadata| {
            metadata
                .get("runtimeRouting")
                .or_else(|| metadata.get("runtime_routing"))
        })
        .and_then(|value| value.as_object())
    else {
        return false;
    };

    if routing
        .get("allowUntargetedAcrossPreferredRuntimes")
        .or_else(|| routing.get("allowRuntimeSpread"))
        .or_else(|| routing.get("allow_runtime_spread"))
        .and_then(|value| value.as_bool())
        == Some(true)
    {
        return true;
    }

    routing
        .get("strategy")
        .or_else(|| routing.get("mode"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .is_some_and(|value| matches!(value.as_str(), "spread" | "parallel" | "scale_out"))
}

fn write_scope_mode(job: &LeaseJob) -> Option<String> {
    write_scope_claim(job)
        .and_then(|scope| scope.get("mode"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .filter(|value| !value.is_empty())
}

fn write_scope_coordination_required_message(job: &LeaseJob) -> Option<String> {
    let scope = write_scope_claim(job)?;
    if write_scope_mode(job).as_deref() != Some("coordination_required") {
        return None;
    }

    let rationale = scope
        .get("rationale")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("This write-heavy multi-agent job needs explicit disjoint file ownership before edits can run.");
    let reason = scope
        .get("conflict")
        .and_then(|value| value.as_object())
        .and_then(|conflict| conflict.get("reason"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let agents = scope
        .get("conflict")
        .and_then(|value| value.as_object())
        .and_then(|conflict| conflict.get("agents"))
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut message =
        String::from("Write-scope coordination required before this agent can edit files.");
    message.push(' ');
    message.push_str(rationale);
    if let Some(reason) = reason {
        message.push_str(" Reason: ");
        message.push_str(reason);
        message.push('.');
    }
    if !agents.is_empty() {
        message.push_str(" Affected agents: ");
        message.push_str(&agents.join(", "));
        message.push('.');
    }
    Some(message)
}

fn write_scope_claim(job: &LeaseJob) -> Option<&serde_json::Map<String, serde_json::Value>> {
    job.payload
        .get("metadata")
        .and_then(|metadata| {
            metadata
                .get("writeScope")
                .or_else(|| metadata.get("write_scope"))
        })
        .and_then(|scope| scope.as_object())
        .or_else(|| {
            job.payload
                .get("metadata")
                .and_then(|metadata| metadata.get("agent"))
                .and_then(|agent| agent.get("writeScope").or_else(|| agent.get("write_scope")))
                .and_then(|scope| scope.as_object())
        })
}

fn resolve_secrets_refresh_interval_seconds() -> u64 {
    let raw = match std::env::var("RUNTIME_SECRETS_REFRESH_INTERVAL_SECONDS") {
        Ok(value) => value,
        Err(_) => return 15,
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 15;
    }
    match trimmed.parse::<u64>() {
        Ok(value) => value,
        Err(_) => 15,
    }
}

fn should_restart_origin_after_failed_tunnel(
    tunnel_assignment_present: bool,
    tunnel_lifecycle_present: bool,
    origin_overrides_present: bool,
) -> bool {
    tunnel_assignment_present && !tunnel_lifecycle_present && origin_overrides_present
}

enum LoopSignal {
    Completed,
    Shutdown,
    Refresh,
}

impl RuntimeAgent {
    async fn sleep_or_shutdown(duration: Duration, shutdown: ShutdownSignal) -> bool {
        matches!(
            Self::sleep_or_signal(duration, shutdown, None).await,
            LoopSignal::Shutdown
        )
    }

    async fn sleep_or_signal(
        duration: Duration,
        shutdown: ShutdownSignal,
        refresh: Option<Arc<Notify>>,
    ) -> LoopSignal {
        tokio::select! {
            _ = shutdown.cancelled() => LoopSignal::Shutdown,
            _ = Self::wait_for_refresh(refresh) => LoopSignal::Refresh,
            _ = sleep(duration) => LoopSignal::Completed,
        }
    }

    async fn wait_for_refresh(refresh: Option<Arc<Notify>>) {
        if let Some(notify) = refresh {
            notify.notified().await;
        } else {
            pending::<()>().await;
        }
    }
}

fn apply_job_secrets(managed_keys: &Mutex<HashSet<String>>, secrets: &JobSecrets) {
    const SECRET_INVENTORY_ENV_KEY: &str = "INSTAFY_PROJECT_SECRET_INVENTORY";

    let mut resolved_env = secrets.env.clone();
    apply_canonical_secret_aliases(&mut resolved_env, &secrets.inventory);
    if let Some(serialized_inventory) = serialize_secret_inventory(&secrets.inventory) {
        resolved_env.insert(SECRET_INVENTORY_ENV_KEY.to_string(), serialized_inventory);
    }

    let mut guard = managed_keys.lock();

    let previous: Vec<String> = guard.iter().cloned().collect();
    for key in previous {
        if resolved_env.contains_key(&key) {
            continue;
        }
        unsafe { std::env::remove_var(&key) };
        guard.remove(&key);
    }

    for (key, value) in resolved_env {
        unsafe { std::env::set_var(&key, value) };
        guard.insert(key);
    }
}

fn apply_canonical_secret_aliases(
    env: &mut HashMap<String, String>,
    inventory: &[AgentSecretInventoryItem],
) {
    ensure_provider_canonical_secret(env, inventory, "github", "GITHUB_TOKEN");
}

fn ensure_provider_canonical_secret(
    env: &mut HashMap<String, String>,
    inventory: &[AgentSecretInventoryItem],
    provider: &str,
    canonical_name: &str,
) {
    if env_contains_key_ci(env, canonical_name) {
        return;
    }

    let Some(value) = resolve_provider_secret_value(env, inventory, provider, canonical_name)
    else {
        return;
    };
    env.insert(canonical_name.to_string(), value);
}

fn serialize_secret_inventory(inventory: &[AgentSecretInventoryItem]) -> Option<String> {
    if inventory.is_empty() {
        return None;
    }

    let mut payload: Vec<serde_json::Value> = Vec::new();
    for item in inventory {
        let name = item.name.trim();
        if name.is_empty() {
            continue;
        }
        let description = item
            .description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        payload.push(json!({
            "name": name,
            "description": description,
        }));
    }

    if payload.is_empty() {
        return None;
    }

    serde_json::to_string(&payload).ok()
}

fn env_contains_key_ci(env: &HashMap<String, String>, name: &str) -> bool {
    env.keys().any(|key| key.eq_ignore_ascii_case(name))
}

fn find_env_value_ci(env: &HashMap<String, String>, name: &str) -> Option<String> {
    for (key, value) in env {
        if key.eq_ignore_ascii_case(name) {
            return Some(value.clone());
        }
    }
    None
}

fn resolve_provider_secret_value(
    env: &HashMap<String, String>,
    inventory: &[AgentSecretInventoryItem],
    provider: &str,
    canonical_name: &str,
) -> Option<String> {
    if let Some(value) = find_env_value_ci(env, canonical_name) {
        return Some(value);
    }

    let keywords = provider_keywords(provider);
    let mut provider_candidates: Vec<String> = Vec::new();
    for item in inventory {
        let name = item.name.trim();
        if name.is_empty() || find_env_value_ci(env, name).is_none() {
            continue;
        }
        let provider_match = text_contains_any_keyword_ci(name, keywords)
            || item
                .description
                .as_deref()
                .map(|value| text_contains_any_keyword_ci(value, keywords))
                .unwrap_or(false);
        if provider_match {
            push_unique_case_insensitive(&mut provider_candidates, name);
        }
    }

    if let Some(best) = provider_candidates.first() {
        return find_env_value_ci(env, best);
    }

    let mut available_inventory_names: Vec<String> = Vec::new();
    for item in inventory {
        let name = item.name.trim();
        if name.is_empty() || find_env_value_ci(env, name).is_none() {
            continue;
        }
        push_unique_case_insensitive(&mut available_inventory_names, name);
    }
    if available_inventory_names.len() == 1 {
        if let Some(name) = available_inventory_names.first() {
            return find_env_value_ci(env, name);
        }
    }

    None
}

fn provider_keywords(provider: &str) -> &'static [&'static str] {
    match provider.trim().to_ascii_lowercase().as_str() {
        "github" => &["github"],
        _ => &[],
    }
}

fn text_contains_any_keyword_ci(value: &str, keywords: &[&str]) -> bool {
    if keywords.is_empty() {
        return false;
    }
    let lowered = value.to_ascii_lowercase();
    keywords.iter().any(|keyword| lowered.contains(keyword))
}

fn push_unique_case_insensitive(values: &mut Vec<String>, candidate: &str) {
    if values
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(candidate))
    {
        return;
    }
    values.push(candidate.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_signal_remains_observable_after_work_finishes() {
        let shutdown = ShutdownSignal::new();
        shutdown.cancel();

        tokio::time::timeout(Duration::from_secs(1), shutdown.cancelled())
            .await
            .expect("sticky shutdown must not wait for a second notification");
    }

    #[tokio::test]
    async fn shutdown_signal_wakes_every_current_waiter() {
        let shutdown = ShutdownSignal::new();
        let first = tokio::spawn({
            let shutdown = shutdown.clone();
            async move { shutdown.cancelled().await }
        });
        let second = tokio::spawn({
            let shutdown = shutdown.clone();
            async move { shutdown.cancelled().await }
        });

        tokio::task::yield_now().await;
        shutdown.cancel();

        tokio::time::timeout(Duration::from_secs(1), async {
            first.await.expect("first waiter should exit");
            second.await.expect("second waiter should exit");
        })
        .await
        .expect("all shutdown waiters should wake");
    }

    #[test]
    fn desktop_parent_is_the_only_shutdown_disposition_actor() {
        assert!(!should_self_disposition_runtime_on_shutdown(true));
        assert!(should_self_disposition_runtime_on_shutdown(false));
    }

    #[test]
    fn runtime_token_without_tunnel_assignment_does_not_restart_origin() {
        assert!(!should_restart_origin_after_failed_tunnel(
            false, false, true
        ));
    }

    #[test]
    fn failed_tunnel_lifecycle_restarts_origin_without_tunnel_metadata() {
        assert!(should_restart_origin_after_failed_tunnel(true, false, true));
    }

    #[test]
    fn successful_tunnel_lifecycle_keeps_registered_origin() {
        assert!(!should_restart_origin_after_failed_tunnel(true, true, true));
    }

    #[test]
    fn apply_canonical_secret_aliases_supports_generic_names_with_provider_description() {
        let mut env = HashMap::from([("TOKEN".to_string(), "token-value".to_string())]);
        let inventory = vec![AgentSecretInventoryItem {
            name: "TOKEN".to_string(),
            description: Some("Token for GitHub issue reads".to_string()),
        }];

        apply_canonical_secret_aliases(&mut env, &inventory);

        assert_eq!(env.get("GITHUB_TOKEN"), Some(&"token-value".to_string()));
    }

    #[test]
    fn apply_canonical_secret_aliases_uses_single_secret_fallback() {
        let mut env = HashMap::from([("TOKEN".to_string(), "token-value".to_string())]);
        let inventory = vec![AgentSecretInventoryItem {
            name: "TOKEN".to_string(),
            description: None,
        }];

        apply_canonical_secret_aliases(&mut env, &inventory);

        assert_eq!(env.get("GITHUB_TOKEN"), Some(&"token-value".to_string()));
    }

    #[test]
    fn write_scope_coordination_required_explains_apply_guardrail() {
        let job = lease_job_with_metadata(json!({
            "writeScope": {
                "mode": "coordination_required",
                "rationale": "overlapping file ownership",
                "conflict": {
                    "reason": "overlapping_write_scope",
                    "agents": ["@ben", "@octo"]
                }
            }
        }));

        let message = write_scope_coordination_required_message(&job)
            .expect("coordination-required scope should block");
        assert!(message.contains("Write-scope coordination required"));
        assert!(message.contains("overlapping_write_scope"));
        assert!(message.contains("@ben, @octo"));
    }

    #[test]
    fn write_scope_owned_paths_do_not_block_apply_jobs() {
        let job = lease_job_with_metadata(json!({
            "writeScope": {
                "mode": "owned",
                "ownedPaths": ["src/App.tsx"],
                "rationale": "explicit owned path"
            }
        }));

        assert!(write_scope_coordination_required_message(&job).is_none());
    }

    #[test]
    fn read_only_batches_can_be_leased_together() {
        let first = lease_job_with_metadata(json!({
            "writeScope": {
                "mode": "read_only",
                "rationale": "security audit"
            }
        }));
        let second = lease_job_with_metadata(json!({
            "agent": {
                "writeScope": {
                    "mode": "read-only",
                    "rationale": "security audit"
                }
            }
        }));

        assert!(should_run_batch_as_read_only_group(&[first, second]));
    }

    #[test]
    fn runtime_spread_read_only_jobs_are_not_batched_inside_one_runtime() {
        let first = lease_job_with_metadata(json!({
            "writeScope": {
                "mode": "read_only"
            },
            "runtimeRouting": {
                "strategy": "spread"
            }
        }));
        let second = lease_job_with_metadata(json!({
            "writeScope": {
                "mode": "read_only"
            }
        }));

        assert!(!should_run_batch_as_read_only_group(&[first, second]));
    }

    #[test]
    fn write_batches_stay_serial_inside_one_runtime() {
        let read_only = lease_job_with_metadata(json!({
            "writeScope": {
                "mode": "read_only"
            }
        }));
        let owned = lease_job_with_metadata(json!({
            "writeScope": {
                "mode": "owned",
                "ownedPaths": ["src/App.tsx"]
            }
        }));

        assert!(!should_run_batch_as_read_only_group(&[read_only, owned]));
    }

    #[test]
    fn exact_owned_write_paths_detect_parent_child_conflicts() {
        assert!(direct_write_scopes_conflict(
            "tmp/work/alpha",
            "tmp/work/alpha/bravo.txt"
        ));
        assert!(direct_write_scopes_conflict(
            "tmp/work/alpha/bravo.txt",
            "tmp/work/alpha"
        ));
        assert!(direct_write_scopes_conflict(
            "tmp/work/alpha.txt",
            "tmp/work/alpha.txt"
        ));
        assert!(!direct_write_scopes_conflict(
            "tmp/work/alpha.txt",
            "tmp/work/alpha-notes.txt"
        ));
        assert!(direct_write_scopes_conflict(
            "tmp/work/alpha/**",
            "tmp/work/alpha/bravo.txt"
        ));
        assert!(direct_write_scopes_conflict(
            "tmp/work/alpha/bravo.txt",
            "tmp/work/alpha/**"
        ));
        assert!(!direct_write_scopes_conflict(
            "tmp/work/alpha/**",
            "tmp/work/alpha-notes/bravo.txt"
        ));
    }

    fn lease_job_with_metadata(metadata: serde_json::Value) -> LeaseJob {
        LeaseJob {
            id: Uuid::new_v4(),
            intent: Some("feature".to_string()),
            project_id: Some(Uuid::new_v4()),
            run_id: Some(Uuid::new_v4()),
            conversation_id: Some(Uuid::new_v4()),
            session_id: None,
            credential_id: None,
            payload: json!({
                "prompt_text": "edit files",
                "metadata": metadata
            }),
            proxy: None,
            controller_token: None,
            controller_token_scopes: None,
            controller_token_expires_at: None,
            workspace_token: None,
            workspace_token_scopes: None,
            workspace_token_expires_at: None,
        }
    }
}
