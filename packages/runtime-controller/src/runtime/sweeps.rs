use anyhow::{Context, Result as AnyResult};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde_json::json;
use std::time::{Duration, Instant};
use tracing::{info, warn};
use uuid::Uuid;

use crate::bug_reports::{record_system_bug_report, SystemBugReportInput};
use crate::credits::process_credit_burn;
use crate::provider_identifiers::provider_id_key;
use crate::tunnels::revoke_tunnels_for_scope;
use crate::{publish_controller_event, AppState};

use super::db::{fetch_runtime_for_update, release_origin_instances_for_runtime};
use super::ensure::ensure_runtime_for_requeued_jobs;
use super::provider::{call_provider_endpoint, select_provider_config, ProviderReleaseRequest};
use super::status::release_leases_for_project;
use super::stop::{stop_runtime_safely, SafeRuntimeStop, StopOptions};

const TERMINAL_RUNTIME_RETENTION_SECONDS: i64 = 10 * 60;
const TERMINAL_RUNTIME_CLEANUP_BATCH_SIZE: i64 = 50;
const REQUESTED_RUNTIME_LAUNCH_TIMEOUT_SECONDS: i64 = 15 * 60;
const REQUESTED_RUNTIME_CLEANUP_BATCH_SIZE: i64 = 50;
const STUCK_QUEUED_JOB_MAX_AGE_SECONDS: i64 = 90;
const STUCK_QUEUED_RUNTIME_HEARTBEAT_MAX_AGE_SECONDS: i64 = 60;
const STUCK_REGISTERED_LOOP_WINDOW_SECONDS: i64 = 90;
const STUCK_REGISTERED_EVENT_THRESHOLD: i64 = 8;
const STUCK_QUEUED_RECOVERY_BATCH_SIZE: i64 = 20;
// Desktop drain leases last 90 seconds and desktop runtimes heartbeat every
// 60 seconds. Requiring a heartbeat in the final 70 seconds distinguishes a
// live runtime whose Electron parent disappeared from one killed immediately
// after its final drain renewal.
pub(crate) const DRAIN_RECOVERY_HEARTBEAT_WINDOW_SECONDS: i64 = 70;
const AUTO_STOP_STALE_RUNTIMES_QUERY: &str = "select id from runtimes
     where status not in ('stopped', 'offline', 'removed')
       and idle_ttl_seconds > 0
       and last_seen_at is not null
       and (last_seen_at + interval '1 second' * idle_ttl_seconds) < now()";
/// How long a stop-requeued job may wait for a runtime before it expires
/// instead of silently re-running whenever a runtime next appears.
const REQUEUED_JOB_EXPIRY_SECONDS: i64 = 15 * 60;
/// runtime_events is an append-only telemetry/audit log with no natural bound.
/// Nothing reads rows older than a few days (the widest reader lookback is the
/// 7-day OOM window), so retain two weeks and prune the rest. Without this the
/// table grew to millions of rows / ~1.8 GB in production and blew the database
/// size quota.
const RUNTIME_EVENT_RETENTION_SECONDS: i64 = 14 * 24 * 60 * 60;
/// Rows deleted per statement. Bounded so each statement is cheap and holds no
/// long lock.
const RUNTIME_EVENT_CLEANUP_BATCH_SIZE: i64 = 5000;
/// Batches per prune invocation. At 5k/batch this drains up to 100k rows per
/// run; on a several-minute ticker a multi-million-row backlog clears within a
/// few hours while steady state deletes only the day's trickle.
const RUNTIME_EVENT_CLEANUP_MAX_BATCHES_PER_RUN: u32 = 20;
const HOSTED_RUNTIME_BILLING_POOL_PRESSURE_REPORT_AFTER: Duration = Duration::from_secs(15 * 60);

pub(crate) fn should_report_hosted_runtime_credit_sweep_error(
    error: &anyhow::Error,
    transient_failure_started_at: &mut Option<Instant>,
    now: Instant,
) -> bool {
    let is_pool_timeout = error.chain().any(|cause| {
        cause
            .to_string()
            .to_ascii_lowercase()
            .contains("timed out in bb8")
    });
    if !is_pool_timeout {
        *transient_failure_started_at = None;
        return true;
    }

    let started_at = transient_failure_started_at.get_or_insert(now);
    now.saturating_duration_since(*started_at) >= HOSTED_RUNTIME_BILLING_POOL_PRESSURE_REPORT_AFTER
}

pub(crate) fn reset_hosted_runtime_credit_sweep_pool_pressure(
    transient_failure_started_at: &mut Option<Instant>,
) {
    *transient_failure_started_at = None;
}

pub(crate) async fn sweep_idle_activity(state: &AppState) -> AnyResult<()> {
    resume_expired_runtime_drains(state).await?;
    let candidates = state.runtime_activity.idle_candidates().await;

    for (project_id, entry) in candidates {
        let released = release_leases_for_project(
            state,
            &project_id,
            entry.idle_ttl_seconds,
            "background_idle_sweep",
        )
        .await?;
        if released > 0 {
            state.runtime_activity.mark_released(&project_id).await;
        } else {
            state
                .runtime_activity
                .mark_active(project_id, Some(entry.idle_ttl_seconds), Some(Utc::now()))
                .await;
        }
    }

    auto_stop_orphan_requested_runtimes(state).await?;
    auto_stop_stuck_requested_runtimes(state).await?;
    auto_stop_stale_runtimes(state).await?;
    auto_stop_idle_hosted_runtimes(state).await?;
    expire_stale_requeued_jobs(state).await?;
    auto_recover_stuck_queued_runtimes(state).await?;
    cleanup_terminal_runtime_records(state).await?;

    Ok(())
}

pub(super) async fn resume_expired_runtime_drains(state: &AppState) -> AnyResult<()> {
    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for expired runtime drain recovery")?;
    let resumed = connection
        .execute(
            "update runtimes
             set status = 'ready', drain_expires_at = null, updated_at = now()
             where status = 'draining'
               and drain_expires_at <= now()
               and last_seen_at > drain_expires_at
                   - ($1::bigint * interval '1 second')",
            &[&DRAIN_RECOVERY_HEARTBEAT_WINDOW_SECONDS],
        )
        .await
        .context("failed to recover expired runtime drain leases")?;
    if resumed > 0 {
        info!(resumed, "recovered expired desktop runtime drain leases");
    }
    Ok(())
}

/// Deletes runtime_events older than the retention window in bounded batches.
/// runtime_events is an append-only log (heartbeats, lifecycle transitions,
/// agent completions) that nothing reads beyond a few days; left unbounded it
/// reached millions of rows / ~1.8 GB in production.
///
/// Runs on its own slow ticker (not the 10s idle sweep) and deliberately does
/// NOT `order by` — any row past the cutoff is equally deletable, so skipping
/// the sort lets each batch run as a cheap bounded scan without depending on a
/// dedicated `created_at` index. A large backlog drains over successive ticks;
/// a caught-up table deletes nothing. Note this reclaims space for reuse but
/// does not shrink the on-disk file — that needs a one-off VACUUM FULL.
pub(crate) async fn prune_expired_runtime_events(state: &AppState) -> AnyResult<()> {
    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for runtime_events pruning")?;

    let mut total_deleted: u64 = 0;
    // Drain a bounded amount per invocation so a huge backlog clears over a few
    // ticks rather than one unbounded statement, but a single tick still makes
    // real progress.
    for _ in 0..RUNTIME_EVENT_CLEANUP_MAX_BATCHES_PER_RUN {
        let deleted = connection
            .execute(
                "delete from runtime_events
                 where ctid in (
                   select ctid
                   from runtime_events
                   where created_at < now() - ($1::bigint * interval '1 second')
                   limit $2
                 )",
                &[
                    &RUNTIME_EVENT_RETENTION_SECONDS,
                    &RUNTIME_EVENT_CLEANUP_BATCH_SIZE,
                ],
            )
            .await
            .context("failed to prune expired runtime_events")?;
        total_deleted += deleted;
        if deleted < RUNTIME_EVENT_CLEANUP_BATCH_SIZE as u64 {
            break;
        }
    }

    if total_deleted > 0 {
        info!(deleted = total_deleted, "pruned expired runtime_events");
    }

    Ok(())
}

/// Jobs requeued by a runtime stop expire if nothing resumes them promptly.
/// Without this, a job killed by credit exhaustion re-runs from scratch
/// whenever a runtime next appears — even days later — duplicating side
/// effects and burning fresh credits unprompted.
async fn expire_stale_requeued_jobs(state: &AppState) -> AnyResult<()> {
    let mut connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for requeued job expiry")?;
    let transaction = connection
        .transaction()
        .await
        .context("failed to start requeued job expiry transaction")?;

    // Only expire jobs with no live runtime to run them: a stamped job merely
    // waiting behind a busy, healthy runtime will be leased normally.
    let rows = transaction
        .query(
            "update agent_jobs
             set status = 'failed',
                 outcome = 'expired',
                 error_message = 'This run was interrupted when its runtime stopped and was not resumed within 15 minutes. Send it again if you still need it.',
                 completed_at = now(),
                 active_input_ready_runtime_id = null,
                 active_input_ready_expires_at = null,
                 active_input_ready_turn_id = null,
                 updated_at = now()
             where status = 'queued'
               and payload ? 'requeuedAt'
               and (payload ->> 'requeuedAt')::timestamptz
                   < now() - interval '1 second' * $1
               and not exists (
                 select 1 from runtimes r
                 where r.project_id = agent_jobs.project_id
                   and r.status not in ('stopped', 'offline', 'removed')
               )
             returning id, project_id, run_id, conversation_id, payload, error_message",
            &[&(REQUEUED_JOB_EXPIRY_SECONDS as f64)],
        )
        .await
        .context("failed to expire stale requeued jobs")?;

    let mut job_input_state_updates = Vec::new();
    for row in &rows {
        let job_id: Uuid = row.get("id");
        let updates = crate::send_intents::reject_unacknowledged_inputs_for_job(
            &transaction,
            &job_id,
            "requeued agent job expired before input acknowledgement",
        )
        .await
        .map_err(|(status, Json(error))| {
            anyhow::anyhow!(
                "failed to reject inputs for expired requeued job ({status}): {}",
                error.message
            )
        })?;
        job_input_state_updates.extend(updates);

        // The job is dead, so its run is too: without this the run stays
        // "in_progress" forever and Home would list it as live work.
        let run_id: Option<Uuid> = row.get("run_id");
        if let Some(run_id) = run_id {
            let project_id: Uuid = row.get("project_id");
            let conversation_id: Option<Uuid> = row.get("conversation_id");
            let error_message: Option<String> = row.get("error_message");
            let payload = row
                .get::<_, tokio_postgres::types::Json<serde_json::Value>>("payload")
                .0;
            transaction
                .execute(
                    "update runs
                     set status = 'failed',
                         progress_stage = null,
                         last_message = coalesce($2, last_message),
                         updated_at = now()
                     where id = $1
                       and status not in ('success', 'failed', 'canceled')",
                    &[&run_id, &error_message],
                )
                .await
                .context("failed to fail run for expired requeued job")?;
            crate::activity::record_run_completed(
                &transaction,
                &project_id,
                &run_id,
                conversation_id,
                None,
                &payload,
                false,
                None,
                error_message.as_deref(),
            )
            .await;
        }
    }

    transaction
        .commit()
        .await
        .context("failed to commit requeued job expiry")?;
    crate::send_intents::publish_job_input_state_updates(state, &job_input_state_updates);

    for row in rows {
        let job_id: Uuid = row.get("id");
        let project_id: Uuid = row.get("project_id");
        info!(
            job_id = %job_id,
            project_id = %project_id,
            "expired stale requeued job"
        );
    }

    Ok(())
}

/// Tells the frontend a runtime stopped and why, so a deliberate pause
/// (idle, credits) renders as an explained state instead of an "unexpected
/// stop" that gets silently auto-restarted.
fn notify_runtime_stopped(
    state: &AppState,
    project_id: Uuid,
    runtime_id: Uuid,
    reason: &str,
    source: &str,
) {
    notify_runtime_stopped_with_extra(state, project_id, runtime_id, reason, source, json!({}));
}

fn notify_runtime_stopped_with_extra(
    state: &AppState,
    project_id: Uuid,
    runtime_id: Uuid,
    reason: &str,
    source: &str,
    extra: serde_json::Value,
) {
    let mut payload = json!({
        "runtimeId": runtime_id,
        "status": "stopped",
        "reason": reason,
        "source": source,
    });
    if let (Some(target), Some(extra_map)) = (payload.as_object_mut(), extra.as_object()) {
        for (key, value) in extra_map {
            target.insert(key.clone(), value.clone());
        }
    }
    publish_controller_event(
        &state.events,
        "runtime.stopped",
        Some(project_id),
        None,
        Some(runtime_id),
        None,
        payload,
    );
}

/// Asks the runtime's provider whether the container died to the OOM killer.
/// Best-effort and read-only: any failure just means "unknown".
async fn inspect_runtime_oom(state: &AppState, runtime_id: &Uuid) -> Option<bool> {
    let connection = state.pool.get().await.ok()?;
    let row = connection
        .query_opt(
            "select project_id, provider from runtimes where id = $1",
            &[runtime_id],
        )
        .await
        .ok()??;
    let project_id: Uuid = row.get("project_id");
    let provider: String = row.get("provider");
    if !crate::provider_identifiers::is_instafy_cloud_provider_id(&provider) {
        return None;
    }
    let provider_cfg = select_provider_config(state, &provider)?;
    let body = call_provider_endpoint(
        state,
        &provider_cfg,
        "/runtime/inspect",
        &ProviderReleaseRequest {
            project_id: &project_id,
            runtime_id,
            lease_id: None,
        },
    )
    .await
    .ok()??;
    let parsed: serde_json::Value = serde_json::from_str(&body).ok()?;
    parsed
        .get("oom_killed")
        .and_then(serde_json::Value::as_bool)
}

/// How many times this project's runtimes were OOM-killed in the last week —
/// the "consistently hitting the memory wall" signal behind the Boost prompt.
async fn count_recent_oom_events(state: &AppState, project_id: &Uuid) -> Option<i64> {
    let connection = state.pool.get().await.ok()?;
    let row = connection
        .query_one(
            "select count(*)::bigint as oom_count from runtime_events
             where project_id = $1
               and kind = 'stopped'
               and data ->> 'reason' = 'oom_killed'
               and created_at > now() - interval '7 days'",
            &[project_id],
        )
        .await
        .ok()?;
    Some(row.get::<_, i64>("oom_count"))
}

/// Stops healthy hosted runtimes that nobody is using: no leased job and no
/// job/user activity for `runtime_idle_stop_seconds`. Without this sweep an
/// abandoned runtime bills 13 credits per 8 minutes until the org runs dry —
/// and the daily refill lets it keep draining every day's allowance.
/// The workspace mount survives; the runtime wakes via the existing
/// auto-ensure on the next interaction.
async fn auto_stop_idle_hosted_runtimes(state: &AppState) -> AnyResult<()> {
    let idle_stop_seconds = state.config.runtime_idle_stop_seconds;
    if idle_stop_seconds <= 0 {
        return Ok(());
    }

    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for idle runtime sweep")?;

    // Every condition here is durable (DB) on purpose: the in-memory activity
    // tracker is refreshed by sweep bookkeeping and dies on restart, so it can
    // neither prove activity nor idleness. Genuine user pings land in
    // project_user_activity; agent work lands in agent_jobs; the boot grace
    // comes from the active lease, not runtimes.created_at (rows are reused
    // across wake cycles).
    let rows = connection
        .query(
            "select r.id, r.project_id, r.provider from runtimes r
             left join runtime_leases rl on rl.id = r.active_lease_id
             where r.status not in ('stopped', 'offline', 'removed')
               and coalesce(rl.launched_at, rl.requested_at, r.created_at)
                   < now() - interval '1 second' * $1
               and not exists (
                 select 1 from agent_jobs j
                 where j.leased_by_runtime_id = r.id and j.status = 'leased'
               )
               and not exists (
                 select 1 from agent_jobs j
                 where j.project_id = r.project_id
                   and greatest(
                     coalesce(j.updated_at, to_timestamp(0)),
                     coalesce(j.heartbeat_at, to_timestamp(0)),
                     coalesce(j.leased_at, to_timestamp(0))
                   ) > now() - interval '1 second' * $1
               )
               and not exists (
                 select 1 from project_user_activity a
                 where a.project_id = r.project_id
                   and a.last_active_at > now() - interval '1 second' * $1
               )",
            &[&(idle_stop_seconds as f64)],
        )
        .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            // Schema lag (project_user_activity not migrated yet): fail SAFE —
            // skip idle stops entirely rather than stop without the activity
            // signal and risk killing an active user's runtime.
            let code = error.as_db_error().map(|db_error| db_error.code().clone());
            if code == Some(tokio_postgres::error::SqlState::UNDEFINED_TABLE) {
                warn!("project_user_activity table missing; skipping idle runtime sweep");
                return Ok(());
            }
            return Err(error).context("failed to select idle runtimes");
        }
    };
    // Safe stop acquires its own connection; release the candidate-query slot
    // before entering the loop so DATABASE_POOL_SIZE=1 remains viable.
    drop(connection);

    for row in rows {
        let runtime_id: Uuid = row.get("id");
        let provider: String = row.get("provider");

        // Only hosted runtimes: a bring-your-own machine belongs to the user
        // and costs the platform nothing while idle.
        if !crate::provider_identifiers::is_instafy_cloud_provider_id(&provider) {
            continue;
        }

        let stop_options = StopOptions {
            source: "idle_stop",
            reason: Some("idle".to_string()),
            skip_if_active_jobs: true,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        };
        let stop_reason_label = stop_options
            .reason
            .clone()
            .unwrap_or_else(|| stop_options.source.to_string());

        match stop_runtime_safely(state, &runtime_id, stop_options).await {
            Ok(SafeRuntimeStop { runtime, outcome }) => {
                if outcome.status_changed {
                    info!(
                        runtime_id = %runtime.id,
                        project_id = %runtime.project_id,
                        idle_stop_seconds,
                        "stopped idle hosted runtime"
                    );
                    if let Err((status, payload)) = revoke_tunnels_for_scope(
                        state,
                        &runtime.project_id,
                        Some(&runtime.id),
                        outcome.released_runtime_lease_id.as_ref(),
                        &stop_reason_label,
                    )
                    .await
                    {
                        warn!(
                            runtime_id = %runtime.id,
                            project_id = %runtime.project_id,
                            %status,
                            error = payload.0.message,
                            "failed to auto-revoke tunnels during idle stop"
                        );
                    }
                    notify_runtime_stopped(
                        state,
                        runtime.project_id,
                        runtime.id,
                        "idle",
                        "idle_stop",
                    );
                    // A queued job slipped in between the idle SELECT and the
                    // stop: the runtime wasn't actually idle — resume the work
                    // immediately instead of leaving it to the expiry sweep.
                    if !outcome.requeued_jobs.is_empty() {
                        if let Err((status, Json(api_error))) =
                            ensure_runtime_for_requeued_jobs(state, &runtime, "idle_stop_recovery")
                                .await
                        {
                            warn!(
                                runtime_id = %runtime.id,
                                project_id = %runtime.project_id,
                                requeued_job_count = outcome.requeued_jobs.len(),
                                status = status.as_u16(),
                                error = %api_error.message,
                                "failed to resume requeued jobs after idle stop"
                            );
                        }
                    }
                }
            }
            Err((status, body)) => {
                warn!(
                    runtime_id = %runtime_id,
                    %status,
                    error = body.0.message,
                    "failed to stop idle runtime"
                );
            }
        }
    }

    Ok(())
}

fn hosted_runtime_usage_bucket(
    now: DateTime<Utc>,
    started_at: DateTime<Utc>,
    interval_seconds: i64,
) -> i64 {
    let interval = interval_seconds.max(1);
    let elapsed_seconds = now.signed_duration_since(started_at).num_seconds().max(0);
    elapsed_seconds / interval
}

fn hosted_runtime_billing_idempotency_key(runtime_id: Uuid, lease_id: Uuid, bucket: i64) -> String {
    format!("hosted_runtime:{runtime_id}:{lease_id}:{bucket}")
}

fn should_request_runtime_recovery(requeued_jobs: usize) -> bool {
    requeued_jobs > 0
}

fn should_recover_stuck_queued_runtime(
    stale_queued_jobs: i64,
    recent_registered_events: i64,
    runtime_heartbeat_stale: bool,
) -> bool {
    stale_queued_jobs > 0
        && (runtime_heartbeat_stale || recent_registered_events >= STUCK_REGISTERED_EVENT_THRESHOLD)
}

fn runtime_status_allows_stale_heartbeat_recovery(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "ready" | "running" | "online" | "degraded"
    )
}

fn runtime_heartbeat_stale_for_queued_recovery(
    provider: &str,
    status: &str,
    last_seen_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    if !crate::provider_identifiers::is_instafy_cloud_provider_id(provider) {
        return false;
    }
    if !runtime_status_allows_stale_heartbeat_recovery(status) {
        return false;
    }
    let Some(last_seen_at) = last_seen_at else {
        return true;
    };
    now.signed_duration_since(last_seen_at).num_seconds()
        > STUCK_QUEUED_RUNTIME_HEARTBEAT_MAX_AGE_SECONDS
}

pub(crate) async fn sweep_hosted_runtime_credit_usage(state: &AppState) -> AnyResult<()> {
    let mut provider_rates = std::collections::HashMap::<String, (String, i32, i64)>::new();
    for provider in state.provider_registry.provider_configs() {
        if !crate::provider_identifiers::is_instafy_cloud_provider_id(&provider.id) {
            continue;
        }
        let (burn_amount, interval_seconds) =
            crate::credits::resolve_hosted_runtime_credit_burn_config_for_provider(
                state, &provider,
            );
        if burn_amount <= 0 {
            continue;
        }
        provider_rates.insert(
            provider_id_key(&provider.id),
            (provider.id, burn_amount, interval_seconds),
        );
    }
    if provider_rates.is_empty() {
        return Ok(());
    }

    let now = Utc::now();

    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for hosted runtime billing")?;

    let rows = connection
        .query(
            "select r.id as runtime_id,
                    r.project_id as project_id,
                    p.org_id as org_id,
                    r.provider as provider,
                    r.active_lease_id as lease_id,
                    coalesce(rl.launched_at, rl.requested_at, now()) as started_at,
                    rl.metadata ->> 'sizeId' as size_id
             from runtimes r
             join projects p on p.id = r.project_id
             left join runtime_leases rl on rl.id = r.active_lease_id
             where p.org_id is not null
               and r.active_lease_id is not null
               and (
                 replace(lower(r.provider), '-', '_') = 'instafy_cloud'
                 or replace(lower(r.provider), '-', '_') like 'instafy\\_cloud\\_%'
               )
               and r.status not in ('stopped','offline','removed')",
            &[],
        )
        .await
        .context("failed to select active hosted runtimes for billing")?;
    // Per-runtime burns and safe stops acquire their own pool slot.
    drop(connection);

    for row in rows {
        let runtime_id: Uuid = row.get("runtime_id");
        let project_id: Uuid = row.get("project_id");
        let org_id: Uuid = row.get("org_id");
        let provider_id: String = row.get("provider");
        let lease_id: Uuid = row.get("lease_id");
        let started_at: DateTime<Utc> = row.get("started_at");
        let size_id: Option<String> = row.get("size_id");
        let runtime_size = crate::runtime::sizes::resolve_runtime_size(size_id.as_deref());

        let provider_key = provider_id_key(&provider_id);
        let Some((billing_provider_id, base_burn_amount, interval_seconds)) =
            provider_rates.get(&provider_key).cloned()
        else {
            continue;
        };
        // Boosted machines burn proportionally more — the size travels on the
        // lease metadata, validated at ensure time.
        let burn_amount = crate::runtime::sizes::scaled_burn_amount(base_burn_amount, runtime_size);
        let bucket = hosted_runtime_usage_bucket(now, started_at, interval_seconds);
        let idempotency_key = hosted_runtime_billing_idempotency_key(runtime_id, lease_id, bucket);

        let mut metadata = json!({
            "feature": "runtime.hosted",
            "source": "background_sweep",
            "provider": billing_provider_id,
            "intervalSeconds": interval_seconds,
            "bucket": bucket,
            "runtimeId": runtime_id.to_string(),
            "runtimeLeaseId": lease_id.to_string(),
            "runtimeSize": runtime_size.id,
        });

        let mut burn_connection = match state.pool.get().await {
            Ok(connection) => connection,
            Err(error) => {
                warn!(
                    runtime_id = %runtime_id,
                    %error,
                    "failed to acquire hosted runtime billing connection"
                );
                continue;
            }
        };
        let transaction = match burn_connection.transaction().await {
            Ok(tx) => tx,
            Err(error) => {
                warn!(%error, "failed to start hosted runtime billing transaction");
                continue;
            }
        };

        let burn_result = process_credit_burn(
            &transaction,
            &project_id,
            &org_id,
            Some(runtime_id),
            burn_amount,
            "hosted_runtime",
            Some(idempotency_key.as_str()),
            &mut metadata,
        )
        .await;

        match burn_result {
            Ok(_) => {
                if let Err(error) = transaction.commit().await {
                    warn!(
                        runtime_id = %runtime_id,
                        %error,
                        "failed to commit hosted runtime credit burn"
                    );
                }
            }
            Err((status, Json(err))) if status == StatusCode::BAD_REQUEST => {
                transaction.rollback().await.ok();
                drop(burn_connection);
                warn!(
                    runtime_id = %runtime_id,
                    project_id = %project_id,
                    org_id = %org_id,
                    error = %err.message,
                    "hosted runtime billing rejected; stopping runtime"
                );
                if let Err(error) = stop_runtime_for_credit_exhaustion(state, runtime_id).await {
                    warn!(
                        runtime_id = %runtime_id,
                        project_id = %project_id,
                        org_id = %org_id,
                        %error,
                        "failed to stop hosted runtime after credit exhaustion"
                    );
                }
            }
            Err((status, Json(err))) => {
                transaction.rollback().await.ok();
                warn!(
                    runtime_id = %runtime_id,
                    project_id = %project_id,
                    org_id = %org_id,
                    %status,
                    error = %err.message,
                    "hosted runtime billing failed"
                );
            }
        }
    }

    Ok(())
}

async fn stop_runtime_for_credit_exhaustion(state: &AppState, runtime_id: Uuid) -> AnyResult<()> {
    let stop_options = StopOptions {
        source: "credit_billing",
        reason: Some("credits_exhausted".to_string()),
        skip_if_active_jobs: false,
        require_idle_timeout: false,
        allow_cleanup_pending_release: false,
        expected_identity: None,
    };
    let stop_reason_label = stop_options
        .reason
        .clone()
        .unwrap_or_else(|| stop_options.source.to_string());

    let SafeRuntimeStop { runtime, outcome } =
        match stop_runtime_safely(state, &runtime_id, stop_options).await {
            Ok(result) => result,
            Err((status, body)) => {
                warn!(
                    runtime_id = %runtime_id,
                    %status,
                    error = body.0.message,
                    "failed to stop runtime after credit exhaustion"
                );
                return Ok(());
            }
        };

    if outcome.status_changed {
        if let Err((status, payload)) = revoke_tunnels_for_scope(
            state,
            &runtime.project_id,
            Some(&runtime.id),
            outcome.released_runtime_lease_id.as_ref(),
            &stop_reason_label,
        )
        .await
        {
            warn!(
                runtime_id = %runtime.id,
                project_id = %runtime.project_id,
                %status,
                error = payload.0.message,
                "failed to auto-revoke tunnels during credit exhaustion stop"
            );
        }

        notify_runtime_stopped(
            state,
            runtime.project_id,
            runtime.id,
            "credits_exhausted",
            "credit_billing",
        );
    }

    Ok(())
}

async fn auto_stop_stale_runtimes(state: &AppState) -> AnyResult<()> {
    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for stale runtime sweep")?;

    let rows = connection
        .query(AUTO_STOP_STALE_RUNTIMES_QUERY, &[])
        .await
        .context("failed to select stale runtimes")?;
    // OOM inspection and safe stop both acquire their own pool slot.
    drop(connection);

    for row in rows {
        let runtime_id: Uuid = row.get("id");

        // Post-mortem BEFORE the stop transaction (read-only provider call —
        // never hold a DB transaction across HTTP): a heartbeat timeout whose
        // container was OOM-killed is a memory-wall death, not a network blip,
        // and the user deserves to know which.
        let oom_attribution = inspect_runtime_oom(state, &runtime_id).await;

        let stop_reason = if oom_attribution == Some(true) {
            "oom_killed"
        } else {
            "heartbeat_timeout"
        };
        let stop_options = StopOptions {
            source: "heartbeat_timeout",
            reason: Some(stop_reason.to_string()),
            skip_if_active_jobs: true,
            require_idle_timeout: true,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        };
        let stop_reason_label = stop_options
            .reason
            .clone()
            .unwrap_or_else(|| stop_options.source.to_string());

        match stop_runtime_safely(state, &runtime_id, stop_options).await {
            Ok(SafeRuntimeStop { runtime, outcome }) => {
                if outcome.status_changed {
                    if let Err((status, payload)) = revoke_tunnels_for_scope(
                        state,
                        &runtime.project_id,
                        Some(&runtime.id),
                        outcome.released_runtime_lease_id.as_ref(),
                        &stop_reason_label,
                    )
                    .await
                    {
                        warn!(
                            runtime_id = %runtime.id,
                            project_id = %runtime.project_id,
                            %status,
                            error = payload.0.message,
                            "failed to auto-revoke tunnels during heartbeat timeout stop"
                        );
                    }
                    if stop_reason == "oom_killed" {
                        let oom_count = count_recent_oom_events(state, &runtime.project_id)
                            .await
                            .unwrap_or(1);
                        notify_runtime_stopped_with_extra(
                            state,
                            runtime.project_id,
                            runtime.id,
                            "oom_killed",
                            "heartbeat_timeout",
                            json!({ "oomCount": oom_count }),
                        );
                    } else {
                        notify_runtime_stopped(
                            state,
                            runtime.project_id,
                            runtime.id,
                            stop_reason,
                            "heartbeat_timeout",
                        );
                    }
                    // An OOM-killed runtime must not be auto-recovered into the
                    // same wall; the frontend offers Boost / your-own-machine.
                    if stop_reason != "oom_killed"
                        && should_request_runtime_recovery(outcome.requeued_jobs.len())
                    {
                        match ensure_runtime_for_requeued_jobs(
                            state,
                            &runtime,
                            "heartbeat_timeout_recovery",
                        )
                        .await
                        {
                            Ok(response) => {
                                tracing::info!(
                                    project_id = %runtime.project_id,
                                    runtime_id = %response.runtime_id,
                                    lease_id = %response.lease_id,
                                    "requested runtime recovery after heartbeat timeout requeue"
                                );
                            }
                            Err((status, Json(api_error))) => {
                                warn!(
                                    runtime_id = %runtime.id,
                                    project_id = %runtime.project_id,
                                    requeued_job_count = outcome.requeued_jobs.len(),
                                    status = status.as_u16(),
                                    error = %api_error.message,
                                    "failed to request runtime recovery after heartbeat timeout"
                                );
                            }
                        }
                    }
                }
            }
            Err((status, body)) => {
                warn!(
                    runtime_id = %runtime_id,
                    %status,
                    error = body.0.message,
                    "failed to auto-stop stale runtime"
                );
            }
        }
    }

    Ok(())
}

async fn auto_recover_stuck_queued_runtimes(state: &AppState) -> AnyResult<()> {
    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for stuck queued runtime recovery")?;

    let rows = connection
        .query(
            "select r.id as runtime_id,
                    r.provider,
                    r.status as runtime_status,
                    r.last_seen_at,
                    (
                      select count(*)
                      from agent_jobs j
                      where j.project_id = r.project_id
                        and j.status = 'queued'
                        and j.lease_attempts = 0
                        and j.target_runtime_id = r.id
                        and j.created_at < now() - ($1::bigint * interval '1 second')
                    ) as stale_queued_jobs,
                    (
                      select count(*)
                      from runtime_events e
                      where e.runtime_id = r.id
                        and e.kind = 'registered'
                        and e.created_at > now() - ($2::bigint * interval '1 second')
                    ) as recent_registered_events
             from runtimes r
             where r.status not in ('stopped', 'offline', 'removed')
             order by r.updated_at desc
             limit $3",
            &[
                &STUCK_QUEUED_JOB_MAX_AGE_SECONDS,
                &STUCK_REGISTERED_LOOP_WINDOW_SECONDS,
                &STUCK_QUEUED_RECOVERY_BATCH_SIZE,
            ],
        )
        .await
        .context("failed to select stuck queued runtime recovery candidates")?;
    // Safe stop acquires its own connection; do not pin the query slot.
    drop(connection);

    for row in rows {
        let runtime_id: Uuid = row.get("runtime_id");
        let provider: String = row.get("provider");
        let runtime_status: String = row.get("runtime_status");
        let last_seen_at: Option<DateTime<Utc>> = row.get("last_seen_at");
        let stale_queued_jobs: i64 = row.get("stale_queued_jobs");
        let recent_registered_events: i64 = row.get("recent_registered_events");
        let runtime_heartbeat_stale = runtime_heartbeat_stale_for_queued_recovery(
            provider.as_str(),
            runtime_status.as_str(),
            last_seen_at,
            Utc::now(),
        );
        if !should_recover_stuck_queued_runtime(
            stale_queued_jobs,
            recent_registered_events,
            runtime_heartbeat_stale,
        ) {
            continue;
        }

        let stop_options = StopOptions {
            source: "queued_stall_recovery",
            reason: Some("queued_stall_recovery".to_string()),
            skip_if_active_jobs: true,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        };
        let stop_reason_label = stop_options
            .reason
            .clone()
            .unwrap_or_else(|| stop_options.source.to_string());

        match stop_runtime_safely(state, &runtime_id, stop_options).await {
            Ok(SafeRuntimeStop { runtime, outcome }) => {
                if outcome.status_changed {
                    if let Err((status, payload)) = revoke_tunnels_for_scope(
                        state,
                        &runtime.project_id,
                        Some(&runtime.id),
                        outcome.released_runtime_lease_id.as_ref(),
                        &stop_reason_label,
                    )
                    .await
                    {
                        warn!(
                            runtime_id = %runtime.id,
                            project_id = %runtime.project_id,
                            %status,
                            error = payload.0.message,
                            "failed to auto-revoke tunnels during queued stall recovery"
                        );
                    }
                    if should_request_runtime_recovery(outcome.requeued_jobs.len()) {
                        match ensure_runtime_for_requeued_jobs(
                            state,
                            &runtime,
                            "queued_stall_recovery",
                        )
                        .await
                        {
                            Ok(response) => {
                                info!(
                                    project_id = %runtime.project_id,
                                    runtime_id = %response.runtime_id,
                                    lease_id = %response.lease_id,
                                    stale_queued_jobs,
                                    recent_registered_events,
                                    runtime_heartbeat_stale,
                                    "requested runtime recovery after queued stall detection"
                                );
                            }
                            Err((status, Json(api_error))) => {
                                warn!(
                                    runtime_id = %runtime.id,
                                    project_id = %runtime.project_id,
                                    stale_queued_jobs,
                                    recent_registered_events,
                                    runtime_heartbeat_stale,
                                    status = status.as_u16(),
                                    error = %api_error.message,
                                    "failed to request runtime recovery after queued stall detection"
                                );
                            }
                        }
                    }
                }
            }
            Err((status, body)) => {
                warn!(
                    runtime_id = %runtime_id,
                    stale_queued_jobs,
                    recent_registered_events,
                    runtime_heartbeat_stale,
                    %status,
                    error = body.0.message,
                    "failed to auto-recover stuck queued runtime"
                );
            }
        }
    }

    Ok(())
}

async fn auto_stop_stuck_requested_runtimes(state: &AppState) -> AnyResult<()> {
    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for requested runtime sweep")?;

    let rows = connection
        .query(
            "select r.id
             from runtimes r
             join runtime_leases rl on rl.id = r.active_lease_id
             where r.status = 'requested'
               and r.active_lease_id is not null
               and r.last_seen_at is null
               and rl.released_at is null
               and rl.requested_at < now() - ($1::bigint * interval '1 second')
             order by rl.requested_at asc
             limit $2",
            &[
                &REQUESTED_RUNTIME_LAUNCH_TIMEOUT_SECONDS,
                &REQUESTED_RUNTIME_CLEANUP_BATCH_SIZE,
            ],
        )
        .await
        .context("failed to select stuck requested runtimes")?;
    // Safe stop acquires its own connection; do not pin the query slot.
    drop(connection);

    for row in rows {
        let runtime_id: Uuid = row.get("id");

        // Avoid permanently blocking org runtime limits on records that never came online.
        let stop_options = StopOptions {
            source: "launch_timeout",
            reason: Some("launch_timeout".to_string()),
            skip_if_active_jobs: true,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        };
        let stop_reason_label = stop_options
            .reason
            .clone()
            .unwrap_or_else(|| stop_options.source.to_string());

        match stop_runtime_safely(state, &runtime_id, stop_options).await {
            Ok(SafeRuntimeStop { runtime, outcome }) => {
                if outcome.status_changed {
                    if let Err((status, payload)) = revoke_tunnels_for_scope(
                        state,
                        &runtime.project_id,
                        Some(&runtime.id),
                        outcome.released_runtime_lease_id.as_ref(),
                        &stop_reason_label,
                    )
                    .await
                    {
                        warn!(
                            runtime_id = %runtime.id,
                            project_id = %runtime.project_id,
                            %status,
                            error = payload.0.message,
                            "failed to auto-revoke tunnels during launch timeout stop"
                        );
                    }
                    if let Err(error) = record_system_bug_report(
                        state,
                        SystemBugReportInput {
                            message: format!(
                                "Hosted runtime launch timed out for provider {}",
                                runtime.provider
                            ),
                            details: Some(
                                "A runtime request stayed in requested/offline state until the launch timeout sweep stopped it."
                                    .to_string(),
                            ),
                            project_id: Some(runtime.project_id),
                            runtime_id: Some(runtime.id),
                            run_id: None,
                            conversation_id: None,
                            priority: "high".to_string(),
                            labels: vec![
                                "runtime".to_string(),
                                "launch-timeout".to_string(),
                                "monitoring".to_string(),
                            ],
                            metadata: json!({
                                "source": "runtime.launch_timeout",
                                "provider": runtime.provider,
                                "runtimeId": runtime.id.to_string(),
                                "projectId": runtime.project_id.to_string(),
                                "leaseId": outcome
                                    .released_runtime_lease_id
                                    .map(|lease_id| lease_id.to_string()),
                            }),
                            logs: json!([
                                {
                                    "kind": "runtime.launch_timeout",
                                    "runtimeId": runtime.id.to_string(),
                                    "projectId": runtime.project_id.to_string(),
                                    "provider": runtime.provider,
                                    "leaseId": outcome
                                        .released_runtime_lease_id
                                        .map(|lease_id| lease_id.to_string()),
                                }
                            ]),
                            fingerprint: Some(format!(
                                "runtime.launch_timeout.{}",
                                runtime.provider
                            )),
                            dedupe_window_seconds: Some(15 * 60),
                        },
                    )
                    .await
                    {
                        warn!(
                            runtime_id = %runtime.id,
                            project_id = %runtime.project_id,
                            %error,
                            "failed to record runtime launch timeout bug report"
                        );
                    }
                }
            }
            Err((status, body)) => {
                warn!(
                    runtime_id = %runtime_id,
                    %status,
                    error = body.0.message,
                    "failed to auto-stop requested runtime"
                );
            }
        }
    }

    Ok(())
}

async fn auto_stop_orphan_requested_runtimes(state: &AppState) -> AnyResult<()> {
    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for orphan requested runtime sweep")?;

    let rows = connection
        .query(
            "select id
             from runtimes
             where status = 'requested'
               and active_lease_id is null
               and last_seen_at is null
               and updated_at < now() - ($1::bigint * interval '1 second')
             order by updated_at asc
             limit $2",
            &[
                &REQUESTED_RUNTIME_LAUNCH_TIMEOUT_SECONDS,
                &REQUESTED_RUNTIME_CLEANUP_BATCH_SIZE,
            ],
        )
        .await
        .context("failed to select orphan requested runtimes")?;
    // Safe stop acquires its own connection; do not pin the query slot.
    drop(connection);

    for row in rows {
        let runtime_id: Uuid = row.get("id");
        let stop_options = StopOptions {
            source: "launch_timeout_orphan",
            reason: Some("launch_timeout".to_string()),
            skip_if_active_jobs: true,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        };
        let stop_reason_label = stop_options
            .reason
            .clone()
            .unwrap_or_else(|| stop_options.source.to_string());

        match stop_runtime_safely(state, &runtime_id, stop_options).await {
            Ok(SafeRuntimeStop { runtime, outcome }) => {
                if outcome.status_changed {
                    if let Err((status, payload)) = revoke_tunnels_for_scope(
                        state,
                        &runtime.project_id,
                        Some(&runtime.id),
                        outcome.released_runtime_lease_id.as_ref(),
                        &stop_reason_label,
                    )
                    .await
                    {
                        warn!(
                            runtime_id = %runtime.id,
                            project_id = %runtime.project_id,
                            %status,
                            error = payload.0.message,
                            "failed to auto-revoke tunnels during orphan requested stop"
                        );
                    }
                }
            }
            Err((status, body)) => {
                warn!(
                    runtime_id = %runtime_id,
                    %status,
                    error = body.0.message,
                    "failed to auto-stop orphan requested runtime"
                );
            }
        }
    }

    Ok(())
}

async fn cleanup_terminal_runtime_records(state: &AppState) -> AnyResult<()> {
    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for terminal runtime cleanup")?;

    let rows = connection
        .query(
            "select id
             from runtimes
             where status in ('stopped', 'offline')
               and updated_at < now() - ($1::bigint * interval '1 second')
             order by updated_at asc
             limit $2",
            &[
                &TERMINAL_RUNTIME_RETENTION_SECONDS,
                &TERMINAL_RUNTIME_CLEANUP_BATCH_SIZE,
            ],
        )
        .await
        .context("failed to select terminal runtime cleanup candidates")?;
    drop(connection);

    let mut removed_count = 0usize;

    for row in rows {
        let runtime_id: Uuid = row.get("id");
        let stopped = match stop_runtime_safely(
            state,
            &runtime_id,
            StopOptions {
                source: "terminal_runtime_cleanup",
                reason: Some("terminal_runtime_cleanup".to_string()),
                skip_if_active_jobs: false,
                require_idle_timeout: false,
                allow_cleanup_pending_release: false,
                expected_identity: None,
            },
        )
        .await
        {
            Ok(stopped) => stopped,
            Err((status, body)) => {
                warn!(
                    runtime_id = %runtime_id,
                    %status,
                    error = body.0.message,
                    "terminal runtime remains fenced because provider cleanup was not acknowledged"
                );
                continue;
            }
        };

        if !stopped.outcome.requeued_jobs.is_empty() {
            warn!(
                runtime_id = %stopped.runtime.id,
                project_id = %stopped.runtime.project_id,
                requeued_job_count = stopped.outcome.requeued_jobs.len(),
                requeued_job_ids = ?stopped.outcome.requeued_jobs,
                "cleared stale job bindings while removing terminal runtime"
            );
        }
        if !stopped.outcome.failed_personal_browser_jobs.is_empty() {
            warn!(
                runtime_id = %stopped.runtime.id,
                project_id = %stopped.runtime.project_id,
                failed_job_count = stopped.outcome.failed_personal_browser_jobs.len(),
                failed_job_ids = ?stopped.outcome.failed_personal_browser_jobs,
                "failed Personal Browser jobs while removing disconnected desktop runtime"
            );
        }

        let mut connection = state
            .pool
            .get()
            .await
            .context("failed to acquire terminal runtime removal connection")?;
        let transaction = connection
            .transaction()
            .await
            .context("failed to start terminal runtime removal transaction")?;
        let runtime = match fetch_runtime_for_update(&transaction, &runtime_id).await {
            Ok(runtime) => runtime,
            Err((status, body)) => {
                transaction
                    .rollback()
                    .await
                    .context("failed to rollback terminal runtime removal transaction")?;
                warn!(
                    runtime_id = %runtime_id,
                    %status,
                    error = body.0.message,
                    "failed to reload runtime for terminal removal"
                );
                continue;
            }
        };
        if runtime.active_lease_id.is_some()
            || (runtime.status != "stopped" && runtime.status != "offline")
        {
            transaction
                .rollback()
                .await
                .context("failed to rollback terminal cleanup generation-race transaction")?;
            continue;
        }

        release_origin_instances_for_runtime(&transaction, &runtime.id)
            .await
            .map_err(|(_, body)| {
                anyhow::anyhow!(
                    "failed to release origin instances during cleanup: {}",
                    body.0.message
                )
            })?;

        let updated = transaction
            .execute(
                "update runtimes
                 set status = 'removed',
                     endpoint_url = null,
                     task_ref = null,
                     last_seen_at = coalesce(last_seen_at, now()),
                     updated_at = now()
                 where id = $1
                   and status in ('stopped', 'offline')
                   and active_lease_id is null",
                &[&runtime.id],
            )
            .await
            .context("failed to mark terminal runtime removed during cleanup")?;

        if updated == 0 {
            transaction
                .rollback()
                .await
                .context("failed to rollback terminal runtime cleanup no-op")?;
            continue;
        }

        transaction
            .commit()
            .await
            .context("failed to commit terminal runtime cleanup")?;
        removed_count += 1;
    }

    if removed_count > 0 {
        tracing::info!(
            removed_count,
            retention_seconds = TERMINAL_RUNTIME_RETENTION_SECONDS,
            "removed stale terminal runtime records"
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        runtime_heartbeat_stale_for_queued_recovery, should_recover_stuck_queued_runtime,
        should_request_runtime_recovery, AUTO_STOP_STALE_RUNTIMES_QUERY,
    };
    use chrono::Duration as ChronoDuration;
    use chrono::Utc;
    use uuid::Uuid;

    #[tokio::test]
    async fn stale_runtime_selector_excludes_removed_rows() -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping stale runtime selector test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        transaction
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        transaction
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, idle_ttl_seconds, last_seen_at
                 ) values ($1, $2, 'instafy-cloud', 'removed', 1, now() - interval '1 hour')",
                &[&runtime_id, &project_id],
            )
            .await?;

        let selected = transaction
            .query(AUTO_STOP_STALE_RUNTIMES_QUERY, &[])
            .await?
            .into_iter()
            .any(|row| row.get::<_, Uuid>("id") == runtime_id);
        assert!(
            !selected,
            "removed runtimes must never be re-stopped by the stale sweep"
        );

        transaction.rollback().await?;
        Ok(())
    }

    #[test]
    fn runtime_recovery_requested_when_jobs_were_requeued() {
        assert!(should_request_runtime_recovery(1));
        assert!(should_request_runtime_recovery(3));
    }

    #[test]
    fn runtime_recovery_not_requested_without_requeued_jobs() {
        assert!(!should_request_runtime_recovery(0));
    }

    #[test]
    fn stuck_queued_recovery_requires_registered_loop_threshold() {
        assert!(should_recover_stuck_queued_runtime(1, 8, false));
        assert!(should_recover_stuck_queued_runtime(3, 20, false));
        assert!(!should_recover_stuck_queued_runtime(0, 20, true));
        assert!(!should_recover_stuck_queued_runtime(2, 7, false));
    }

    #[test]
    fn stuck_queued_recovery_allows_stale_hosted_heartbeat() {
        assert!(should_recover_stuck_queued_runtime(1, 0, true));
    }

    #[test]
    fn hosted_ready_runtime_heartbeat_can_go_stale_for_queued_recovery() {
        let now = Utc::now();
        assert!(runtime_heartbeat_stale_for_queued_recovery(
            "instafy-cloud",
            "ready",
            Some(now - ChronoDuration::seconds(90)),
            now,
        ));
        assert!(!runtime_heartbeat_stale_for_queued_recovery(
            "instafy-cloud",
            "requested",
            Some(now - ChronoDuration::seconds(90)),
            now,
        ));
        assert!(!runtime_heartbeat_stale_for_queued_recovery(
            "self_hosted",
            "ready",
            Some(now - ChronoDuration::seconds(90)),
            now,
        ));
    }
}
