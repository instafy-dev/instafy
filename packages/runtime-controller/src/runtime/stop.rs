use std::str::FromStr;

use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::Transaction;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use crate::agent::{
    ensure_agent_token_matches_runtime_lease_for_stop, extract_agent_token,
    verify_agent_token_with_scopes, TokenContext,
};
use crate::auth::{authenticate_request, RequestContext};
use crate::tunnels::revoke_tunnels_for_scope;
use crate::{
    bad_request, ensure_project_write_access, forbidden, internal_error, load_project_record,
    not_found, publish_controller_event, unauthorized, ApiError, AppState,
};

use super::db::{
    fetch_runtime_for_update, fetch_runtime_lease_for_update, mark_runtime_lease_released,
    record_runtime_event, release_origin_instances_for_runtime, RuntimeDetails,
};
use super::provider::{
    call_provider_endpoint, lock_and_load_authoritative_provider_config, ProviderReleaseRequest,
};

#[derive(Debug, Deserialize)]
pub(crate) struct RuntimeStopPayload {
    pub(crate) runtime_id: String,
    pub(crate) reason: Option<String>,
    #[serde(default)]
    pub(crate) skip_if_active_jobs: bool,
    /// Require proof of an earlier provider acknowledgement when retrying an
    /// already-terminal runtime. Active provider-managed generations are
    /// always fenced and acknowledged before their lease is released.
    #[serde(default)]
    pub(crate) require_provider_release: bool,
    pub(crate) expected_project_id: Option<String>,
    pub(crate) expected_provider: Option<String>,
    pub(crate) expected_display_name: Option<String>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub(crate) struct RuntimeStopResponse {
    pub(crate) ok: bool,
    pub(crate) status_changed: bool,
    pub(crate) provider_release_attempted: bool,
    pub(crate) provider_release_succeeded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) skip_reason: Option<String>,
}

#[derive(Debug, Default, Eq, PartialEq)]
struct ProviderReleaseOutcome {
    attempted: bool,
    succeeded: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RuntimeIdleReaperPayload {
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeIdleReaperResponse {
    pub(crate) stopped: Vec<Uuid>,
    pub(crate) candidates: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct StopOptions {
    pub(crate) source: &'static str,
    pub(crate) reason: Option<String>,
    pub(crate) skip_if_active_jobs: bool,
    pub(crate) require_idle_timeout: bool,
    /// Only set after the exact provider lease generation acknowledged release.
    pub(crate) allow_cleanup_pending_release: bool,
    pub(crate) expected_identity: Option<RuntimeIdentityExpectation>,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeIdentityExpectation {
    pub(crate) project_id: Option<Uuid>,
    pub(crate) provider: Option<String>,
    pub(crate) display_name: Option<String>,
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct StopOutcome {
    pub(crate) runtime_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) status_changed: bool,
    pub(crate) requeued_jobs: Vec<Uuid>,
    pub(crate) failed_personal_browser_jobs: Vec<Uuid>,
    pub(crate) failed_shared_browser_jobs: Vec<Uuid>,
    pub(crate) skip_reason: Option<String>,
    pub(crate) released_runtime_lease_id: Option<Uuid>,
}

impl StopOutcome {
    fn skipped(runtime: &RuntimeDetails, reason: impl Into<String>) -> Self {
        Self {
            runtime_id: runtime.id,
            project_id: runtime.project_id,
            status_changed: false,
            requeued_jobs: Vec::new(),
            failed_personal_browser_jobs: Vec::new(),
            failed_shared_browser_jobs: Vec::new(),
            skip_reason: Some(reason.into()),
            released_runtime_lease_id: None,
        }
    }
}

impl RuntimeStopResponse {
    fn from_outcome(outcome: &StopOutcome) -> Self {
        Self {
            ok: true,
            status_changed: outcome.status_changed,
            provider_release_attempted: false,
            provider_release_succeeded: false,
            skip_reason: outcome.skip_reason.clone(),
        }
    }

    fn with_provider_release(
        mut self,
        provider_release: &ProviderReleaseOutcome,
        required: bool,
    ) -> Self {
        self.provider_release_attempted = provider_release.attempted;
        self.provider_release_succeeded = provider_release.succeeded;
        self.ok = !required || provider_release.succeeded;
        self
    }
}

pub(crate) const PERSONAL_BROWSER_DISCONNECTED_ERROR: &str =
    "Personal Browser disconnected. Reconnect the desktop app and retry this request.";
pub(crate) const SHARED_BROWSER_DISCONNECTED_ERROR: &str =
    "Shared Browser disconnected because its runtime stopped. Reopen the Shared Browser and retry this request.";

#[derive(Debug, Default)]
pub(super) struct UnavailableRuntimeJobDisposition {
    pub(super) requeued_jobs: Vec<Uuid>,
    pub(super) failed_personal_browser_jobs: Vec<Uuid>,
    pub(super) failed_shared_browser_jobs: Vec<Uuid>,
}

enum StopAuth {
    Agent(TokenContext),
    User(RequestContext),
}

#[derive(Debug)]
pub(super) struct SafeRuntimeStop {
    pub(super) runtime: RuntimeDetails,
    pub(super) outcome: StopOutcome,
}

async fn runtime_has_active_hosted_jobs(
    transaction: &Transaction<'_>,
    runtime_id: &Uuid,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    transaction
        .query_one(
            "select exists(
                select 1
                from agent_jobs
                where leased_by_runtime_id = $1
                  and status = 'leased'
                  and (lease_expires_at is null or lease_expires_at > now())
                  and lower(replace(btrim(coalesce(
                        payload #>> '{metadata,browserTransport}',
                        payload #>> '{metadata,browser_transport}',
                        ''
                      )), '_', '-')) <> 'desktop-personal'
            )",
            &[runtime_id],
        )
        .await
        .map(|row| row.get(0))
        .map_err(|error| internal_error(format!("failed to check active jobs: {error}")))
}

/// Fence an exact provider allocation before release. New ensures and late
/// registrations fail closed while the provider operation is in flight; a
/// failed, timed-out, or cancelled stop remains retryable in this state.
async fn quarantine_runtime_for_provider_release(
    transaction: &Transaction<'_>,
    runtime: &RuntimeDetails,
    lease_id: &Uuid,
    reason: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let lease = fetch_runtime_lease_for_update(transaction, lease_id).await?;
    if lease.project_id != runtime.project_id
        || lease.runtime_id != Some(runtime.id)
        || lease.released_at.is_some()
        || runtime.active_lease_id != Some(*lease_id)
    {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "runtime lease generation is no longer current",
            )),
        ));
    }

    if lease.status != "cleanup_pending" {
        let rows = transaction
            .execute(
                "update runtime_leases
                 set status = 'cleanup_pending', updated_at = now()
                 where id = $1
                   and runtime_id = $2
                   and released_at is null
                   and status <> 'released'",
                &[lease_id, &runtime.id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to quarantine runtime before provider release: {error}"
                ))
            })?;
        if rows != 1 {
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "runtime lease generation is no longer current",
                )),
            ));
        }
    }

    let job_disposition =
        resolve_jobs_for_unavailable_runtime(transaction, runtime, reason).await?;
    let rows = transaction
        .execute(
            "update runtimes
             set status = 'requested',
                 endpoint_url = null,
                 task_ref = null,
                 last_seen_at = null,
                 updated_at = now()
             where id = $1 and active_lease_id = $2",
            &[&runtime.id, lease_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to quarantine runtime record before provider release: {error}"
            ))
        })?;
    if rows != 1 {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "runtime lease generation is no longer current",
            )),
        ));
    }

    release_origin_instances_for_runtime(transaction, &runtime.id).await?;
    record_runtime_event(
        transaction,
        &runtime.id,
        &runtime.project_id,
        "provider_release_cleanup_pending",
        json!({
            "reason": reason,
            "provider": runtime.provider,
            "runtimeLeaseId": lease_id,
            "requeuedJobs": job_disposition.requeued_jobs,
            "failedPersonalBrowserJobs": job_disposition.failed_personal_browser_jobs,
            "failedSharedBrowserJobs": job_disposition.failed_shared_browser_jobs,
        }),
    )
    .await?;

    Ok(())
}

async fn preflight_runtime_stop(
    transaction: &Transaction<'_>,
    runtime: &RuntimeDetails,
    options: &StopOptions,
) -> Result<Option<StopOutcome>, (StatusCode, Json<ApiError>)> {
    if options
        .expected_identity
        .as_ref()
        .is_some_and(|expected| !runtime_matches_expected_identity(runtime, expected))
    {
        return Ok(Some(StopOutcome::skipped(
            runtime,
            "runtime_identity_mismatch",
        )));
    }

    if options.require_idle_timeout {
        let Some(last_seen_at) = runtime.last_seen_at else {
            return Ok(Some(StopOutcome::skipped(runtime, "missing_last_seen")));
        };
        if runtime.idle_ttl_seconds <= 0 {
            return Ok(Some(StopOutcome::skipped(runtime, "idle_ttl_not_positive")));
        }
        let cutoff = last_seen_at + ChronoDuration::seconds(runtime.idle_ttl_seconds.into());
        if cutoff > Utc::now() {
            return Ok(Some(StopOutcome::skipped(runtime, "runtime_recently_seen")));
        }
    }

    if options.skip_if_active_jobs
        && !matches!(runtime.status.as_str(), "stopped" | "offline" | "removed")
        && runtime_has_active_hosted_jobs(transaction, &runtime.id).await?
    {
        return Ok(Some(StopOutcome::skipped(runtime, "active_jobs")));
    }

    Ok(None)
}

/// Stop one runtime without ever dropping the database generation fence before
/// its external provider acknowledges release. Background sweeps use this
/// helper so they follow the same two-phase cleanup protocol as explicit stop.
pub(super) async fn stop_runtime_safely(
    state: &AppState,
    runtime_id: &Uuid,
    options: StopOptions,
) -> Result<SafeRuntimeStop, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get stop connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start stop transaction: {error}")))?;
    let runtime = fetch_runtime_for_update(&transaction, runtime_id).await?;
    if provider_runtime_missing_release_generation(state, &runtime) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "provider-managed runtime is missing its active lease generation",
            )),
        ));
    }
    let runtime_snapshot = runtime.clone();

    let provider_release_lease = if let Some(lease_id) = runtime.active_lease_id {
        let lease = fetch_runtime_lease_for_update(&transaction, &lease_id).await?;
        let provider_managed = runtime_requires_provider_release(state, &runtime);
        provider_managed.then_some((lease_id, lease.status == "cleanup_pending"))
    } else {
        None
    };

    if let Some((lease_id, already_quarantined)) = provider_release_lease {
        if !already_quarantined {
            if let Some(outcome) = preflight_runtime_stop(&transaction, &runtime, &options).await? {
                transaction.rollback().await.map_err(|error| {
                    internal_error(format!("failed to rollback skipped stop: {error}"))
                })?;
                return Ok(SafeRuntimeStop {
                    runtime: runtime_snapshot,
                    outcome,
                });
            }
        }

        let stop_reason = options
            .reason
            .as_deref()
            .unwrap_or(options.source)
            .to_string();
        quarantine_runtime_for_provider_release(&transaction, &runtime, &lease_id, &stop_reason)
            .await?;
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to commit runtime provider-release quarantine: {error}"
            ))
        })?;
        drop(connection);

        let provider_release = release_runtime_via_provider(
            state,
            &runtime,
            Some(&lease_id),
            "failed to stop runtime via provider",
        )
        .await;
        if !provider_release.succeeded {
            return Err((
                StatusCode::BAD_GATEWAY,
                Json(ApiError::new(
                    "runtime provider cleanup is still pending; retry the stop",
                )),
            ));
        }

        let mut final_connection = state.pool.get().await.map_err(|error| {
            internal_error(format!(
                "failed to get stop finalization connection: {error}"
            ))
        })?;
        let final_transaction = final_connection.transaction().await.map_err(|error| {
            internal_error(format!(
                "failed to start stop finalization transaction: {error}"
            ))
        })?;
        let current_runtime = fetch_runtime_for_update(&final_transaction, runtime_id).await?;
        if current_runtime.active_lease_id != Some(lease_id) {
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "runtime lease generation is no longer current",
                )),
            ));
        }
        let mut final_options = options;
        // Idle/job preconditions were checked while the original generation
        // was locked, before quarantine. Quarantine intentionally clears
        // heartbeat state and resolves jobs; re-running those predicates now
        // would turn a successful provider acknowledgement into a skipped
        // finalization and strand `cleanup_pending` forever.
        final_options.require_idle_timeout = false;
        final_options.skip_if_active_jobs = false;
        final_options.allow_cleanup_pending_release = true;
        let outcome =
            perform_runtime_stop(&final_transaction, &current_runtime, final_options).await?;
        record_runtime_event(
            &final_transaction,
            &current_runtime.id,
            &current_runtime.project_id,
            "provider_release_acknowledged",
            json!({
                "provider": current_runtime.provider,
                "runtimeLeaseId": lease_id,
            }),
        )
        .await?;
        final_transaction.commit().await.map_err(|error| {
            internal_error(format!("failed to commit stop finalization: {error}"))
        })?;
        return Ok(SafeRuntimeStop {
            runtime: runtime_snapshot,
            outcome,
        });
    }

    let outcome = perform_runtime_stop(&transaction, &runtime, options).await?;
    if outcome.status_changed {
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to commit runtime stop: {error}")))?;
    } else {
        transaction.rollback().await.map_err(|error| {
            internal_error(format!("failed to rollback skipped runtime stop: {error}"))
        })?;
    }

    Ok(SafeRuntimeStop {
        runtime: runtime_snapshot,
        outcome,
    })
}

pub(crate) async fn runtime_stop(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<RuntimeStopPayload>,
) -> Result<(StatusCode, Json<RuntimeStopResponse>), (StatusCode, Json<ApiError>)> {
    let RuntimeStopPayload {
        runtime_id,
        reason,
        skip_if_active_jobs,
        require_provider_release,
        expected_project_id,
        expected_provider,
        expected_display_name,
    } = payload;
    let runtime_id =
        Uuid::from_str(&runtime_id).map_err(|_| bad_request("runtime_id must be a valid UUID"))?;

    let token_value = extract_agent_token(&headers)?.to_string();

    let auth_context =
        match verify_agent_token_with_scopes(&state.config, &token_value, &["agent.stop"]) {
            Ok(context) => {
                let Some(runtime_scope) = context.runtime_id else {
                    return Err(unauthorized("agent token missing runtime scope"));
                };
                if runtime_scope != runtime_id {
                    return Err(unauthorized("agent token runtime scope mismatch"));
                }
                StopAuth::Agent(context)
            }
            Err((status, payload)) => {
                if status != StatusCode::UNAUTHORIZED {
                    return Err((status, payload));
                }
                let user_context = authenticate_request(&state.config, &headers, None).await?;
                StopAuth::User(user_context)
            }
        };

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let runtime = fetch_runtime_for_update(&transaction, &runtime_id).await?;

    match &auth_context {
        StopAuth::Agent(context) => {
            if runtime.project_id != context.project_id {
                return Err(unauthorized(
                    "agent cannot stop runtime from different project",
                ));
            }
            ensure_agent_token_matches_runtime_lease_for_stop(
                &state,
                &transaction,
                context,
                &runtime.id,
            )
            .await?;
        }
        StopAuth::User(context) => {
            // This endpoint is the narrow provider-cleanup control plane used
            // after DELETE /projects/:id has made the project inaccessible to
            // normal users. A directly authenticated service role may finish
            // releasing that exact runtime without reopening generic access to
            // tombstoned projects. User requests retain the usual project
            // write check.
            if !context.is_service_role {
                let project = load_project_record(&transaction, &runtime.project_id).await?;
                ensure_project_write_access(&transaction, &project, context, None).await?;
            }
            super::access::ensure_self_hosted_runtime_access(
                &state,
                &runtime.provider,
                &runtime.capabilities,
                context.user_id,
                context.is_service_role,
            )?;
        }
    }

    let expected_project_id = expected_project_id
        .map(|value| {
            Uuid::from_str(value.trim())
                .map_err(|_| bad_request("expected_project_id must be a valid UUID"))
        })
        .transpose()?;
    let expected_identity = if expected_project_id.is_some()
        || expected_provider.is_some()
        || expected_display_name.is_some()
    {
        Some(RuntimeIdentityExpectation {
            project_id: expected_project_id,
            provider: expected_provider,
            display_name: expected_display_name,
        })
    } else {
        None
    };
    let strict_terminal_release_retry = require_provider_release
        && should_skip_stop_for_terminal_runtime(&runtime)
        && expected_identity
            .as_ref()
            .is_some_and(|expected| runtime_matches_expected_identity(&runtime, expected));

    if provider_runtime_missing_release_generation(&state, &runtime)
        && !strict_terminal_release_retry
    {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "provider-managed runtime is missing its active lease generation",
            )),
        ));
    }

    let stop_options = StopOptions {
        source: "runtime_stop",
        reason,
        skip_if_active_jobs,
        require_idle_timeout: false,
        allow_cleanup_pending_release: false,
        expected_identity,
    };
    let stop_reason_label = stop_options
        .reason
        .clone()
        .unwrap_or_else(|| stop_options.source.to_string());

    // Access control deliberately quarantines unknown/removed provider ids as
    // private. Strict cleanup needs a stronger, positive classification: only
    // a built-in/configured self-hosted provider or protected self-hosted
    // runtime identity proves that no allocator release exists.
    let provider_managed_runtime = runtime_requires_provider_release(&state, &runtime);
    let private_self_hosted_runtime = !provider_managed_runtime;
    let fenced_release_lease_id = if provider_managed_runtime {
        if let Some(lease_id) = runtime.active_lease_id {
            fetch_runtime_lease_for_update(&transaction, &lease_id).await?;
            Some(lease_id)
        } else {
            None
        }
    } else {
        None
    };

    if require_provider_release
        && provider_managed_runtime
        && runtime.active_lease_id.is_none()
        && !should_skip_stop_for_terminal_runtime(&runtime)
    {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "strict provider release requires the active runtime lease generation",
            )),
        ));
    }
    if require_provider_release
        && provider_managed_runtime
        && should_skip_stop_for_terminal_runtime(&runtime)
    {
        let provider_release_was_acknowledged: bool = transaction
            .query_one(
                "select coalesce(
                    (select max(event.id)
                     from runtime_events event
                     where event.runtime_id = $1
                       and event.kind = 'provider_release_acknowledged'
                       and lower(replace(btrim(event.data ->> 'provider'), '_', '-')) =
                           lower(replace(btrim($2::text), '_', '-'))
                       and exists (
                           select 1
                           from runtime_leases lease
                           where lease.runtime_id = $1
                             and lease.id::text = btrim(event.data ->> 'runtimeLeaseId')
                             and lease.status = 'released'
                             and lease.released_at is not null
                       )),
                    0
                 ) > coalesce(
                    (select max(id) from runtime_events
                     where runtime_id = $1
                       and kind = 'stopped'),
                    0
                 )",
                &[&runtime.id, &runtime.provider],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to verify prior provider release acknowledgement: {error}"
                ))
            })?
            .get(0);
        if !provider_release_was_acknowledged {
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError::new(
                    "strict provider release cannot be proven for this terminal runtime",
                )),
            ));
        }
    }

    let preflight_skip = stop_options
        .expected_identity
        .as_ref()
        .is_some_and(|expected| !runtime_matches_expected_identity(&runtime, expected))
        || (stop_options.skip_if_active_jobs
            && !matches!(runtime.status.as_str(), "stopped" | "offline" | "removed")
            && runtime_has_active_hosted_jobs(&transaction, &runtime.id).await?);

    let (outcome, provider_release) =
        if let Some(lease_id) = fenced_release_lease_id.filter(|_| !preflight_skip) {
            quarantine_runtime_for_provider_release(
                &transaction,
                &runtime,
                &lease_id,
                &stop_reason_label,
            )
            .await?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to commit runtime provider-release quarantine: {error}"
                ))
            })?;
            drop(connection);

            let provider_release = release_runtime_via_provider(
                &state,
                &runtime,
                Some(&lease_id),
                "failed to stop runtime via provider",
            )
            .await;
            if !provider_release.succeeded {
                return Ok((
                    StatusCode::BAD_GATEWAY,
                    Json(RuntimeStopResponse {
                        ok: false,
                        status_changed: false,
                        provider_release_attempted: provider_release.attempted,
                        provider_release_succeeded: false,
                        skip_reason: Some("provider_cleanup_pending".to_string()),
                    }),
                ));
            }

            let mut final_connection = state.pool.get().await.map_err(|error| {
                internal_error(format!("failed to get stop connection: {error}"))
            })?;
            let final_transaction = final_connection.transaction().await.map_err(|error| {
                internal_error(format!(
                    "failed to start stop finalization transaction: {error}"
                ))
            })?;
            let current_runtime = fetch_runtime_for_update(&final_transaction, &runtime.id).await?;
            if current_runtime.active_lease_id != Some(lease_id) {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::new(
                        "runtime lease generation is no longer current",
                    )),
                ));
            }
            let mut final_options = stop_options.clone();
            final_options.allow_cleanup_pending_release = true;
            let outcome =
                perform_runtime_stop(&final_transaction, &current_runtime, final_options).await?;
            record_runtime_event(
                &final_transaction,
                &runtime.id,
                &runtime.project_id,
                "provider_release_acknowledged",
                json!({
                    "provider": runtime.provider,
                    "runtimeLeaseId": lease_id,
                }),
            )
            .await?;
            final_transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to commit runtime stop finalization: {error}"
                ))
            })?;
            // `revoke_tunnels_for_scope` acquires its own pool connection.
            // Release the stop-finalization connection first so this path also
            // works with DATABASE_POOL_SIZE=1.
            drop(final_connection);
            (outcome, provider_release)
        } else {
            let outcome = perform_runtime_stop(&transaction, &runtime, stop_options).await?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to commit runtime stop: {error}"))
            })?;
            drop(connection);

            let provider_release = if require_provider_release
                && private_self_hosted_runtime
                && (outcome.status_changed
                    || outcome.skip_reason.as_deref() == Some("already_stopped"))
            {
                // Private self-hosted runtimes have no provider allocation or
                // provider lease generation to release. A successful logical
                // stop (or a verified terminal retry) is the complete strict
                // cleanup acknowledgement. Other skip reasons remain failures.
                ProviderReleaseOutcome {
                    attempted: false,
                    succeeded: true,
                }
            } else if require_provider_release
                && outcome.skip_reason.as_deref() == Some("already_stopped")
            {
                // A stopped runtime can only be finalized by the fenced path after
                // the provider acknowledgement. Treat retries as acknowledged
                // without issuing a generation-blind release.
                ProviderReleaseOutcome {
                    attempted: true,
                    succeeded: true,
                }
            } else {
                ProviderReleaseOutcome::default()
            };
            (outcome, provider_release)
        };

    if let Some(reason) = outcome.skip_reason.as_deref() {
        info!(runtime_id = %runtime_id, %reason, "runtime stop skipped state change");
    }

    if outcome.status_changed {
        if let Err((status, payload)) = revoke_tunnels_for_scope(
            &state,
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
                "failed to auto-revoke tunnels after runtime stop"
            );
        }
    }

    let (status, response) =
        build_runtime_stop_response(&outcome, &provider_release, require_provider_release);

    Ok((status, Json(response)))
}

pub(crate) async fn stop_runtime_for_project(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    reason: Option<String>,
    source: &'static str,
) -> Result<RuntimeStopResponse, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let runtime = fetch_runtime_for_update(&transaction, runtime_id).await?;
    if runtime.project_id != *project_id {
        return Err(not_found("Runtime not found for project."));
    }
    if provider_runtime_missing_release_generation(state, &runtime) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "provider-managed runtime is missing its active lease generation",
            )),
        ));
    }

    let stop_options = StopOptions {
        source,
        reason,
        skip_if_active_jobs: false,
        require_idle_timeout: false,
        allow_cleanup_pending_release: false,
        expected_identity: None,
    };
    let stop_reason_label = stop_options
        .reason
        .clone()
        .unwrap_or_else(|| stop_options.source.to_string());

    let provider_release_lease_id = if let Some(lease_id) = runtime.active_lease_id {
        fetch_runtime_lease_for_update(&transaction, &lease_id).await?;
        runtime_requires_provider_release(state, &runtime).then_some(lease_id)
    } else {
        None
    };

    let (outcome, provider_release) =
        if let Some(lease_id) = provider_release_lease_id {
            quarantine_runtime_for_provider_release(
                &transaction,
                &runtime,
                &lease_id,
                &stop_reason_label,
            )
            .await?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to commit runtime provider-release quarantine: {error}"
                ))
            })?;
            drop(connection);

            let provider_release = release_runtime_via_provider(
                state,
                &runtime,
                Some(&lease_id),
                "failed to stop runtime via provider",
            )
            .await;
            if !provider_release.succeeded {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    Json(ApiError::new(
                        "runtime provider cleanup is still pending; retry the stop",
                    )),
                ));
            }

            let mut final_connection = state.pool.get().await.map_err(|error| {
                internal_error(format!("failed to get stop connection: {error}"))
            })?;
            let final_transaction = final_connection.transaction().await.map_err(|error| {
                internal_error(format!(
                    "failed to start stop finalization transaction: {error}"
                ))
            })?;
            let current_runtime = fetch_runtime_for_update(&final_transaction, &runtime.id).await?;
            if current_runtime.active_lease_id != Some(lease_id) {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::new(
                        "runtime lease generation is no longer current",
                    )),
                ));
            }
            let mut final_options = stop_options.clone();
            final_options.allow_cleanup_pending_release = true;
            let outcome =
                perform_runtime_stop(&final_transaction, &current_runtime, final_options).await?;
            record_runtime_event(
                &final_transaction,
                &runtime.id,
                &runtime.project_id,
                "provider_release_acknowledged",
                json!({
                    "provider": runtime.provider,
                    "runtimeLeaseId": lease_id,
                }),
            )
            .await?;
            final_transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to commit runtime stop finalization: {error}"
                ))
            })?;
            // Tunnel revocation below acquires a fresh pool connection.
            drop(final_connection);
            (outcome, provider_release)
        } else {
            let outcome = perform_runtime_stop(&transaction, &runtime, stop_options).await?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to commit runtime stop: {error}"))
            })?;
            drop(connection);
            (outcome, ProviderReleaseOutcome::default())
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
                "failed to auto-revoke tunnels after runtime stop"
            );
        }
    }

    if let Some(reason) = outcome.skip_reason.as_deref() {
        info!(runtime_id = %runtime_id, %reason, "runtime stop skipped state change");
    }

    Ok(RuntimeStopResponse::from_outcome(&outcome).with_provider_release(&provider_release, false))
}

fn build_runtime_stop_response(
    outcome: &StopOutcome,
    provider_release: &ProviderReleaseOutcome,
    require_provider_release: bool,
) -> (StatusCode, RuntimeStopResponse) {
    let response = RuntimeStopResponse::from_outcome(outcome)
        .with_provider_release(provider_release, require_provider_release);
    let status = if response.ok {
        StatusCode::OK
    } else {
        // Do not return the provider's response body: it may contain internal
        // deployment details. The explicit booleans are the stable contract.
        StatusCode::BAD_GATEWAY
    };
    (status, response)
}

async fn release_runtime_via_provider(
    state: &AppState,
    runtime: &RuntimeDetails,
    lease_id: Option<&Uuid>,
    failure_message: &'static str,
) -> ProviderReleaseOutcome {
    let Some(lease_id) = lease_id else {
        warn!(
            runtime_id = %runtime.id,
            project_id = %runtime.project_id,
            provider = %runtime.provider,
            "generation-blind provider release was rejected"
        );
        return ProviderReleaseOutcome::default();
    };

    // A release must never fall back to another provider or trust a stale
    // process-local route. Load the exact provider's authoritative database
    // row under the same advisory lock used by launch/provider upsert. The
    // cleanup-pending lease keeps route rotation fenced after this transaction
    // commits and while the provider call is in flight.
    let registry_fallback = state.provider_registry.provider_config(&runtime.provider);
    let provider_cfg = async {
        let mut connection = state.pool.get().await.map_err(|error| {
            internal_error(format!(
                "failed to get provider release route connection: {error}"
            ))
        })?;
        let transaction = connection.transaction().await.map_err(|error| {
            internal_error(format!(
                "failed to start provider release route transaction: {error}"
            ))
        })?;
        let provider_cfg = lock_and_load_authoritative_provider_config(
            &transaction,
            &runtime.provider,
            registry_fallback.as_ref(),
        )
        .await?;
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to commit provider release route transaction: {error}"
            ))
        })?;
        Ok::<_, (StatusCode, Json<ApiError>)>(provider_cfg)
    }
    .await;
    let provider_cfg = match provider_cfg {
        Ok(provider_cfg) => provider_cfg,
        Err((status, Json(error))) => {
            warn!(
                runtime_id = %runtime.id,
                project_id = %runtime.project_id,
                provider = %runtime.provider,
                status = %status,
                error = %error.message,
                "failed to resolve authoritative provider route for release"
            );
            return ProviderReleaseOutcome::default();
        }
    };
    let Some(provider_cfg) = provider_cfg else {
        warn!(
            runtime_id = %runtime.id,
            project_id = %runtime.project_id,
            provider = %runtime.provider,
            "runtime provider is not configured; release was not attempted"
        );
        return ProviderReleaseOutcome::default();
    };

    release_runtime_via_resolved_provider(state, runtime, lease_id, &provider_cfg, failure_message)
        .await
}

async fn release_runtime_via_resolved_provider(
    state: &AppState,
    runtime: &RuntimeDetails,
    lease_id: &Uuid,
    provider_cfg: &crate::config::RuntimeProviderConfig,
    failure_message: &'static str,
) -> ProviderReleaseOutcome {
    if provider_cfg
        .endpoint
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        warn!(
            runtime_id = %runtime.id,
            project_id = %runtime.project_id,
            provider = %provider_cfg.id,
            "runtime provider endpoint is not configured; release was not attempted"
        );
        return ProviderReleaseOutcome::default();
    }

    match call_provider_endpoint(
        state,
        provider_cfg,
        "/runtime/release",
        &ProviderReleaseRequest {
            project_id: &runtime.project_id,
            runtime_id: &runtime.id,
            lease_id: Some(lease_id),
        },
    )
    .await
    {
        Ok(_) => ProviderReleaseOutcome {
            attempted: true,
            succeeded: true,
        },
        Err(error) => {
            warn!(
                runtime_id = %runtime.id,
                project_id = %runtime.project_id,
                provider = %provider_cfg.id,
                %error,
                "{failure_message}"
            );
            ProviderReleaseOutcome {
                attempted: true,
                succeeded: false,
            }
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct RuntimeRemovePayload {
    #[serde(rename = "runtimeId", alias = "runtime_id")]
    pub(crate) runtime_id: String,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeRemoveResponse {
    pub(crate) ok: bool,
}

pub(crate) async fn runtime_remove(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<RuntimeRemovePayload>,
) -> Result<Json<RuntimeRemoveResponse>, (StatusCode, Json<ApiError>)> {
    let RuntimeRemovePayload { runtime_id, reason } = payload;
    let runtime_id =
        Uuid::from_str(&runtime_id).map_err(|_| bad_request("runtimeId must be a valid UUID"))?;

    let token_value = extract_agent_token(&headers)?.to_string();

    let auth_context =
        match verify_agent_token_with_scopes(&state.config, &token_value, &["agent.stop"]) {
            Ok(context) => {
                let Some(runtime_scope) = context.runtime_id else {
                    return Err(unauthorized("agent token missing runtime scope"));
                };
                if runtime_scope != runtime_id {
                    return Err(unauthorized("agent token runtime scope mismatch"));
                }
                StopAuth::Agent(context)
            }
            Err((status, payload)) => {
                if status != StatusCode::UNAUTHORIZED {
                    return Err((status, payload));
                }
                let user_context = authenticate_request(&state.config, &headers, None).await?;
                StopAuth::User(user_context)
            }
        };

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let runtime = fetch_runtime_for_update(&transaction, &runtime_id).await?;

    match &auth_context {
        StopAuth::Agent(context) => {
            if runtime.project_id != context.project_id {
                return Err(unauthorized(
                    "agent cannot remove runtime from different project",
                ));
            }
            ensure_agent_token_matches_runtime_lease_for_stop(
                &state,
                &transaction,
                context,
                &runtime.id,
            )
            .await?;
        }
        StopAuth::User(context) => {
            let project = load_project_record(&transaction, &runtime.project_id).await?;
            ensure_project_write_access(&transaction, &project, context, None).await?;
            super::access::ensure_self_hosted_runtime_access(
                &state,
                &runtime.provider,
                &runtime.capabilities,
                context.user_id,
                context.is_service_role,
            )?;
        }
    }

    if provider_runtime_missing_release_generation(&state, &runtime) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "provider-managed runtime is missing its active lease generation",
            )),
        ));
    }

    let stop_options = StopOptions {
        source: "runtime_remove",
        reason: reason.clone(),
        skip_if_active_jobs: false,
        require_idle_timeout: false,
        allow_cleanup_pending_release: false,
        expected_identity: None,
    };
    let stop_label = stop_options
        .reason
        .clone()
        .unwrap_or_else(|| stop_options.source.to_string());

    if let Some(lease_id) = runtime.active_lease_id {
        fetch_runtime_lease_for_update(&transaction, &lease_id).await?;
        if runtime_requires_provider_release(&state, &runtime) {
            quarantine_runtime_for_provider_release(&transaction, &runtime, &lease_id, &stop_label)
                .await?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to commit runtime removal quarantine: {error}"
                ))
            })?;
            drop(connection);

            let provider_release = release_runtime_via_provider(
                &state,
                &runtime,
                Some(&lease_id),
                "failed to stop runtime via provider during remove",
            )
            .await;
            if !provider_release.succeeded {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    Json(ApiError::new(
                        "runtime provider cleanup is still pending; retry removal",
                    )),
                ));
            }

            let mut final_connection = state.pool.get().await.map_err(|error| {
                internal_error(format!("failed to get removal connection: {error}"))
            })?;
            let final_transaction = final_connection.transaction().await.map_err(|error| {
                internal_error(format!(
                    "failed to start removal finalization transaction: {error}"
                ))
            })?;
            let current_runtime = fetch_runtime_for_update(&final_transaction, &runtime.id).await?;
            if current_runtime.active_lease_id != Some(lease_id) {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::new(
                        "runtime lease generation is no longer current",
                    )),
                ));
            }
            let mut final_options = stop_options.clone();
            final_options.allow_cleanup_pending_release = true;
            let outcome =
                perform_runtime_stop(&final_transaction, &current_runtime, final_options).await?;
            record_runtime_event(
                &final_transaction,
                &runtime.id,
                &runtime.project_id,
                "provider_release_acknowledged",
                json!({
                    "provider": runtime.provider,
                    "runtimeLeaseId": lease_id,
                }),
            )
            .await?;
            final_transaction
                .execute(
                    "update runtimes
                     set status = 'removed', endpoint_url = null, task_ref = null,
                         last_seen_at = now(), updated_at = now()
                     where id = $1",
                    &[&runtime.id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to mark runtime removed: {error}"))
                })?;
            final_transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to commit runtime removal: {error}"))
            })?;
            // Runtime preferences and tunnel revocation may perform nested
            // work; never retain the sole database connection across them.
            drop(final_connection);

            state
                .runtime_preferences
                .clear_runtime(&runtime.project_id, &runtime.id)
                .await;
            if let Err((status, payload)) = revoke_tunnels_for_scope(
                &state,
                &runtime.project_id,
                Some(&runtime.id),
                outcome.released_runtime_lease_id.as_ref(),
                &stop_label,
            )
            .await
            {
                warn!(
                    runtime_id = %runtime.id,
                    project_id = %runtime.project_id,
                    %status,
                    error = payload.0.message,
                    "failed to revoke tunnels after runtime removal"
                );
            }
            return Ok(Json(RuntimeRemoveResponse { ok: true }));
        }
    }

    let outcome = perform_runtime_stop(&transaction, &runtime, stop_options).await?;

    // Mark runtime as removed and clear endpoint/task
    transaction
        .execute(
            "update runtimes
             set status = 'removed',
                 endpoint_url = null,
                 task_ref = null,
                 last_seen_at = now(),
                 updated_at = now()
             where id = $1",
            &[&runtime.id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to mark runtime removed: {error}")))?;

    // Clear preference if it points to this runtime.
    state
        .runtime_preferences
        .clear_runtime(&runtime.project_id, &runtime.id)
        .await;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit runtime removal: {error}")))?;
    drop(connection);

    // Revoke tunnels for this runtime scope.
    if let Err((status, payload)) = revoke_tunnels_for_scope(
        &state,
        &runtime.project_id,
        Some(&runtime.id),
        outcome.released_runtime_lease_id.as_ref(),
        &stop_label,
    )
    .await
    {
        warn!(
            runtime_id = %runtime.id,
            project_id = %runtime.project_id,
            %status,
            error = payload.0.message,
            "failed to revoke tunnels after runtime removal"
        );
    }

    Ok(Json(RuntimeRemoveResponse { ok: true }))
}

pub(crate) async fn runtime_idle_reaper(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<RuntimeIdleReaperPayload>,
) -> Result<Json<RuntimeIdleReaperResponse>, (StatusCode, Json<ApiError>)> {
    let auth = authenticate_request(&state.config, &headers, None).await?;
    if !auth.is_service_role {
        return Err(unauthorized("runtime idle reaper requires service role"));
    }

    let limit = payload.limit.unwrap_or(10).clamp(1, 50) as i64;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let candidate_count_row = connection
        .query_one(
            r#"
            select count(*)
            from runtimes r
            where r.status <> 'stopped'
              and r.idle_ttl_seconds > 0
              and r.last_seen_at is not null
              and (r.last_seen_at + interval '1 second' * r.idle_ttl_seconds) < now()
              and not exists (
                select 1 from agent_jobs j
                where j.leased_by_runtime_id = r.id
                  and j.status = 'leased'
              )
            "#,
            &[],
        )
        .await
        .map_err(|error| internal_error(format!("failed to count idle runtimes: {error}")))?;
    let candidate_count: i64 = candidate_count_row.get(0);

    let rows = connection
        .query(
            r#"
            select r.id
            from runtimes r
            where r.status <> 'stopped'
              and r.idle_ttl_seconds > 0
              and r.last_seen_at is not null
              and (r.last_seen_at + interval '1 second' * r.idle_ttl_seconds) < now()
              and not exists (
                select 1 from agent_jobs j
                where j.leased_by_runtime_id = r.id
                  and j.status = 'leased'
              )
            order by r.last_seen_at asc
            limit $1
            "#,
            &[&limit],
        )
        .await
        .map_err(|error| internal_error(format!("failed to select idle runtimes: {error}")))?;
    drop(connection);

    let mut stopped_ids = Vec::new();

    for row in rows {
        let runtime_id: Uuid = row.get("id");

        let stop_options = StopOptions {
            source: "idle_reaper",
            reason: Some("idle_timeout".to_string()),
            skip_if_active_jobs: true,
            require_idle_timeout: true,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        };
        let stop_reason_label = stop_options
            .reason
            .clone()
            .unwrap_or_else(|| stop_options.source.to_string());

        let SafeRuntimeStop { runtime, outcome } =
            match stop_runtime_safely(&state, &runtime_id, stop_options).await {
                Ok(value) => value,
                Err((status, _body)) if status == StatusCode::NOT_FOUND => {
                    info!(runtime_id = %runtime_id, "idle reaper candidate no longer exists");
                    continue;
                }
                Err(error) => return Err(error),
            };

        if outcome.status_changed {
            if let Err((status, payload)) = revoke_tunnels_for_scope(
                &state,
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
                    "failed to auto-revoke tunnels during idle reaper"
                );
            }

            stopped_ids.push(runtime_id);
        } else {
            if let Some(reason) = outcome.skip_reason {
                info!(runtime_id = %runtime_id, %reason, "idle reaper skipped runtime");
            }
        }
    }

    let response = RuntimeIdleReaperResponse {
        stopped: stopped_ids,
        candidates: candidate_count as usize,
    };

    Ok(Json(response))
}

async fn fail_browser_jobs_for_unavailable_runtime(
    transaction: &Transaction<'_>,
    runtime: &RuntimeDetails,
    browser_transport: &str,
    error_message: &str,
    browser_label: &str,
) -> Result<(Vec<Uuid>, Vec<Uuid>), (StatusCode, Json<ApiError>)> {
    let failed_rows = transaction
        .query(
            "update agent_jobs
             set status = 'failed',
                 outcome = 'failed',
                 summary = $3,
                 error_message = $3,
                 leased_by_runtime_id = null,
                 lease_expires_at = null,
                 heartbeat_at = null,
                 completed_at = now(),
                 updated_at = now()
             where project_id = $2
               and (
                 (leased_by_runtime_id = $1 and status = 'leased')
                 or (target_runtime_id = $1 and status = 'queued')
               )
               and lower(replace(btrim(coalesce(
                     payload #>> '{metadata,browserTransport}',
                   payload #>> '{metadata,browser_transport}',
                   ''
                  )), '_', '-')) = $4
             returning id, run_id",
            &[
                &runtime.id,
                &runtime.project_id,
                &error_message,
                &browser_transport,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to fail {browser_label} jobs for unavailable runtime: {error}"
            ))
        })?;

    let failed_jobs: Vec<Uuid> = failed_rows
        .iter()
        .map(|row| row.get::<_, Uuid>("id"))
        .collect();
    let mut failed_runs: Vec<Uuid> = failed_rows
        .iter()
        .filter_map(|row| row.get::<_, Option<Uuid>>("run_id"))
        .collect();
    failed_runs.sort_unstable();
    failed_runs.dedup();

    if !failed_runs.is_empty() {
        transaction
            .execute(
                "update runs
                 set status = 'failed',
                     progress = greatest(progress, 100),
                     progress_stage = null,
                     last_message = $2,
                     updated_at = now()
                 where id = any($1::uuid[])
                   and status in ('queued', 'in_progress', 'awaiting_approval')",
                &[&failed_runs, &error_message],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to fail runs for disconnected {browser_label}: {error}"
                ))
            })?;
    }

    Ok((failed_jobs, failed_runs))
}

pub(super) async fn resolve_jobs_for_unavailable_runtime(
    transaction: &Transaction<'_>,
    runtime: &RuntimeDetails,
    requeue_reason: &str,
) -> Result<UnavailableRuntimeJobDisposition, (StatusCode, Json<ApiError>)> {
    // Browser-bound turns cannot safely move to another runtime: Personal is
    // tied to a device-local profile, while Shared is tied to the exact page
    // and browser process visible to the user. Fail both transports closed and
    // leave their exact target recorded for diagnostics.
    let (failed_personal_browser_jobs, failed_personal_browser_runs) =
        fail_browser_jobs_for_unavailable_runtime(
            transaction,
            runtime,
            "desktop-personal",
            PERSONAL_BROWSER_DISCONNECTED_ERROR,
            "Personal Browser",
        )
        .await?;
    let (failed_shared_browser_jobs, failed_shared_browser_runs) =
        fail_browser_jobs_for_unavailable_runtime(
            transaction,
            runtime,
            "shared",
            SHARED_BROWSER_DISCONNECTED_ERROR,
            "Shared Browser",
        )
        .await?;

    let requeued_rows = transaction
        .query(
            "update agent_jobs
             set status = 'queued',
                 leased_by_runtime_id = null,
                 lease_expires_at = null,
                 leased_at = null,
                 heartbeat_at = null,
                 target_runtime_id = null,
                 payload = payload || jsonb_build_object(
                     'requeuedAt', to_jsonb(now()),
                     'requeuedReason', $3::text
                 ),
                 updated_at = now()
             where project_id = $2
               and (
                 (leased_by_runtime_id = $1 and status = 'leased')
                 or (target_runtime_id = $1 and status = 'queued')
               )
               and lower(replace(btrim(coalesce(
                     payload #>> '{metadata,browserTransport}',
                   payload #>> '{metadata,browser_transport}',
                   ''
                  )), '_', '-')) not in ('desktop-personal', 'shared')
             returning id",
            &[&runtime.id, &runtime.project_id, &requeue_reason],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to requeue jobs for unavailable runtime: {error}"
            ))
        })?;
    let requeued_jobs = requeued_rows
        .into_iter()
        .map(|row| row.get::<_, Uuid>("id"))
        .collect();

    if !failed_personal_browser_jobs.is_empty() {
        record_runtime_event(
            transaction,
            &runtime.id,
            &runtime.project_id,
            "personal_browser_disconnected",
            json!({
                "transport": "desktop-personal",
                "error": PERSONAL_BROWSER_DISCONNECTED_ERROR,
                "job_ids": failed_personal_browser_jobs,
                "run_ids": failed_personal_browser_runs,
            }),
        )
        .await?;
    }

    if !failed_shared_browser_jobs.is_empty() {
        record_runtime_event(
            transaction,
            &runtime.id,
            &runtime.project_id,
            "shared_browser_disconnected",
            json!({
                "transport": "shared",
                "error": SHARED_BROWSER_DISCONNECTED_ERROR,
                "job_ids": failed_shared_browser_jobs,
                "run_ids": failed_shared_browser_runs,
            }),
        )
        .await?;
    }

    Ok(UnavailableRuntimeJobDisposition {
        requeued_jobs,
        failed_personal_browser_jobs,
        failed_shared_browser_jobs,
    })
}

pub(crate) async fn perform_runtime_stop(
    transaction: &Transaction<'_>,
    runtime: &RuntimeDetails,
    options: StopOptions,
) -> Result<StopOutcome, (StatusCode, Json<ApiError>)> {
    let now = Utc::now();

    if options
        .expected_identity
        .as_ref()
        .is_some_and(|expected| !runtime_matches_expected_identity(runtime, expected))
    {
        return Ok(StopOutcome::skipped(runtime, "runtime_identity_mismatch"));
    }

    if options.require_idle_timeout {
        let Some(last_seen_at) = runtime.last_seen_at else {
            return Ok(StopOutcome::skipped(runtime, "missing_last_seen"));
        };
        if runtime.idle_ttl_seconds <= 0 {
            return Ok(StopOutcome::skipped(runtime, "idle_ttl_not_positive"));
        }
        let cutoff = last_seen_at + ChronoDuration::seconds(runtime.idle_ttl_seconds.into());
        if cutoff > now {
            return Ok(StopOutcome::skipped(runtime, "runtime_recently_seen"));
        }
    }

    if options.skip_if_active_jobs {
        let has_active_jobs = runtime_has_active_hosted_jobs(transaction, &runtime.id).await?;

        if has_active_jobs && !matches!(runtime.status.as_str(), "stopped" | "offline" | "removed")
        {
            return Ok(StopOutcome::skipped(runtime, "active_jobs"));
        }
    }

    let requeue_reason = options.reason.as_deref().unwrap_or(options.source);
    let job_disposition =
        resolve_jobs_for_unavailable_runtime(transaction, runtime, requeue_reason).await?;
    let requeued_jobs = job_disposition.requeued_jobs;
    let failed_personal_browser_jobs = job_disposition.failed_personal_browser_jobs;
    let failed_shared_browser_jobs = job_disposition.failed_shared_browser_jobs;

    if should_skip_stop_for_terminal_runtime(runtime) {
        // Job reconciliation may still have changed rows that must commit, but
        // a terminal runtime must retain its status and its last `stopped`
        // event. Rewriting `removed` to `stopped` (or appending another event)
        // would invalidate the ordered provider acknowledgement used by strict
        // idempotent cleanup.
        let status_changed = !requeued_jobs.is_empty()
            || !failed_personal_browser_jobs.is_empty()
            || !failed_shared_browser_jobs.is_empty();
        return Ok(StopOutcome {
            runtime_id: runtime.id,
            project_id: runtime.project_id,
            status_changed,
            requeued_jobs,
            failed_personal_browser_jobs,
            failed_shared_browser_jobs,
            skip_reason: Some("already_stopped".to_string()),
            released_runtime_lease_id: None,
        });
    }

    transaction
        .execute(
            "update runtimes
             set status = 'stopped',
                 endpoint_url = null,
                 task_ref = null,
                 last_seen_at = now(),
                 updated_at = now()
             where id = $1",
            &[&runtime.id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update runtime status: {error}")))?;

    let mut released_runtime_lease_id = None;
    if let Some(lease_id) = runtime.active_lease_id {
        mark_runtime_lease_released(
            transaction,
            &runtime.id,
            &lease_id,
            options.allow_cleanup_pending_release,
        )
        .await?;
        released_runtime_lease_id = Some(lease_id);
    }

    release_origin_instances_for_runtime(transaction, &runtime.id).await?;

    let event_payload = {
        let mut event_data = JsonMap::new();
        event_data.insert(
            "status".to_string(),
            JsonValue::String(runtime.status.clone()),
        );
        event_data.insert(
            "provider".to_string(),
            JsonValue::String(runtime.provider.clone()),
        );
        if let Some(reason) = options.reason.as_ref() {
            event_data.insert("reason".to_string(), JsonValue::String(reason.clone()));
        }
        if let Some(last_seen_at) = runtime.last_seen_at {
            event_data.insert(
                "last_seen_at".to_string(),
                JsonValue::String(last_seen_at.to_rfc3339()),
            );
            let idle_seconds = (now - last_seen_at).num_seconds();
            if idle_seconds > 0 {
                event_data.insert(
                    "idle_duration_seconds".to_string(),
                    JsonValue::from(idle_seconds),
                );
            }
        }
        event_data.insert(
            "idle_ttl_seconds".to_string(),
            JsonValue::from(runtime.idle_ttl_seconds),
        );
        if !requeued_jobs.is_empty() {
            let jobs: Vec<JsonValue> = requeued_jobs
                .iter()
                .map(|job_id| JsonValue::String(job_id.to_string()))
                .collect();
            event_data.insert("requeued_jobs".to_string(), JsonValue::Array(jobs));
        }
        if !failed_personal_browser_jobs.is_empty() {
            let jobs: Vec<JsonValue> = failed_personal_browser_jobs
                .iter()
                .map(|job_id| JsonValue::String(job_id.to_string()))
                .collect();
            event_data.insert(
                "failed_personal_browser_jobs".to_string(),
                JsonValue::Array(jobs),
            );
            event_data.insert(
                "personal_browser_error".to_string(),
                JsonValue::String(PERSONAL_BROWSER_DISCONNECTED_ERROR.to_string()),
            );
        }
        if !failed_shared_browser_jobs.is_empty() {
            let jobs: Vec<JsonValue> = failed_shared_browser_jobs
                .iter()
                .map(|job_id| JsonValue::String(job_id.to_string()))
                .collect();
            event_data.insert(
                "failed_shared_browser_jobs".to_string(),
                JsonValue::Array(jobs),
            );
            event_data.insert(
                "shared_browser_error".to_string(),
                JsonValue::String(SHARED_BROWSER_DISCONNECTED_ERROR.to_string()),
            );
        }
        JsonValue::Object(event_data)
    };

    record_runtime_event(
        transaction,
        &runtime.id,
        &runtime.project_id,
        "stopped",
        event_payload,
    )
    .await?;

    info!(
        runtime_id = %runtime.id,
        project_id = %runtime.project_id,
        requeued_job_count = requeued_jobs.len(),
        failed_personal_browser_job_count = failed_personal_browser_jobs.len(),
        failed_shared_browser_job_count = failed_shared_browser_jobs.len(),
        source = options.source,
        "runtime stopped"
    );

    Ok(StopOutcome {
        runtime_id: runtime.id,
        project_id: runtime.project_id,
        status_changed: true,
        requeued_jobs,
        failed_personal_browser_jobs,
        failed_shared_browser_jobs,
        skip_reason: None,
        released_runtime_lease_id,
    })
}

fn runtime_matches_expected_identity(
    runtime: &RuntimeDetails,
    expected: &RuntimeIdentityExpectation,
) -> bool {
    if expected
        .project_id
        .is_some_and(|project_id| runtime.project_id != project_id)
    {
        return false;
    }

    if let Some(expected_provider) = expected.provider.as_deref() {
        let normalize_provider =
            |provider: &str| provider.trim().to_ascii_lowercase().replace('_', "-");
        if normalize_provider(&runtime.provider) != normalize_provider(expected_provider) {
            return false;
        }
    }

    if let Some(expected_display_name) = expected.display_name.as_deref() {
        if runtime.display_name.as_deref().map(str::trim) != Some(expected_display_name.trim()) {
            return false;
        }
    }

    true
}

fn should_skip_stop_for_terminal_runtime(runtime: &RuntimeDetails) -> bool {
    matches!(runtime.status.as_str(), "stopped" | "removed") && runtime.active_lease_id.is_none()
}

fn provider_runtime_missing_release_generation(state: &AppState, runtime: &RuntimeDetails) -> bool {
    runtime_requires_provider_release(state, runtime)
        && runtime.active_lease_id.is_none()
        // The generic lifecycle paths may trust only the normal stopped state.
        // A strict explicit stop separately admits `removed` solely so it can
        // verify the ordered provider acknowledgement before succeeding.
        && runtime.status != "stopped"
        && !(runtime.status == "requested"
            && runtime.endpoint_url.is_none()
            && runtime.task_ref.is_none()
            && runtime.last_seen_at.is_none())
}

fn runtime_requires_provider_release(state: &AppState, runtime: &RuntimeDetails) -> bool {
    // Unknown provider ids are private for human access, but that quarantine
    // must not be interpreted as proof that no external allocation exists.
    // Only a positive provider classification or protected runtime identity
    // can bypass provider-release fencing.
    !(super::provider::provider_is_self_hosted(state, &runtime.provider)
        || super::access::runtime_has_private_self_hosted_identity(
            &runtime.provider,
            &runtime.capabilities,
        ))
}

#[cfg(test)]
mod tests {
    use super::{
        build_runtime_stop_response, provider_runtime_missing_release_generation,
        release_runtime_via_provider, release_runtime_via_resolved_provider,
        runtime_matches_expected_identity, should_skip_stop_for_terminal_runtime,
        ProviderReleaseOutcome, RuntimeIdentityExpectation, RuntimeStopPayload,
        RuntimeStopResponse, StopOutcome,
    };
    use crate::config::RuntimeProviderConfig;
    use crate::runtime::db::RuntimeDetails;
    use crate::tests::{
        build_app_config, build_test_state, test_origin_private_key, test_origin_public_key,
    };
    use axum::http::StatusCode;
    use bb8::Pool;
    use bb8_postgres::PostgresConnectionManager;
    use httpmock::{Method::POST, MockServer};
    use serde_json::json;
    use tokio::time::{timeout, Duration};
    use tokio_postgres::NoTls;
    use uuid::Uuid;

    fn runtime_details(status: &str, active_lease_id: Option<Uuid>) -> RuntimeDetails {
        RuntimeDetails {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            provider: "instafy_cloud".to_string(),
            capabilities: json!({}),
            status: status.to_string(),
            idle_ttl_seconds: 300,
            last_seen_at: None,
            endpoint_url: None,
            task_ref: None,
            display_name: Some("Hosted Runtime".to_string()),
            active_lease_id,
        }
    }

    #[test]
    fn already_stopped_without_active_lease_can_short_circuit() {
        let runtime = runtime_details("stopped", None);
        assert!(should_skip_stop_for_terminal_runtime(&runtime));
    }

    #[test]
    fn stopped_runtime_with_active_lease_requires_cleanup_path() {
        let runtime = runtime_details("stopped", Some(Uuid::new_v4()));
        assert!(!should_skip_stop_for_terminal_runtime(&runtime));
    }

    #[test]
    fn removed_without_active_lease_can_short_circuit_after_strict_acknowledgement() {
        let runtime = runtime_details("removed", None);
        assert!(should_skip_stop_for_terminal_runtime(&runtime));
    }

    #[test]
    fn removed_runtime_with_active_lease_requires_exact_generation_cleanup() {
        let runtime = runtime_details("removed", Some(Uuid::new_v4()));
        assert!(!should_skip_stop_for_terminal_runtime(&runtime));
    }

    #[test]
    fn ambiguous_nonterminal_runtime_without_active_lease_cannot_short_circuit() {
        for status in ["requested", "offline", "ready"] {
            let runtime = runtime_details(status, None);
            assert!(!should_skip_stop_for_terminal_runtime(&runtime));
        }
    }

    #[tokio::test]
    async fn generic_lifecycle_paths_still_fence_removed_managed_runtime_without_generation() {
        let state = test_state_with_provider(None);
        let removed = runtime_details("removed", None);
        let stopped = runtime_details("stopped", None);

        assert!(provider_runtime_missing_release_generation(
            &state, &removed
        ));
        assert!(!provider_runtime_missing_release_generation(
            &state, &stopped
        ));
    }

    #[test]
    fn runtime_stop_payload_defaults_safe_stop_flag_to_false() {
        let runtime_id = Uuid::new_v4();
        let default_payload: RuntimeStopPayload = serde_json::from_value(json!({
            "runtime_id": runtime_id,
            "reason": "manual"
        }))
        .expect("runtime stop payload without safe-stop flag");
        assert!(!default_payload.skip_if_active_jobs);
        assert!(!default_payload.require_provider_release);
        assert!(default_payload.expected_project_id.is_none());
        assert!(default_payload.expected_provider.is_none());
        assert!(default_payload.expected_display_name.is_none());

        let safe_payload: RuntimeStopPayload = serde_json::from_value(json!({
            "runtime_id": runtime_id,
            "skip_if_active_jobs": true,
            "require_provider_release": true,
            "expected_project_id": runtime_id,
            "expected_provider": "instafy-cloud",
            "expected_display_name": "Hosted Runtime"
        }))
        .expect("runtime stop payload with safe-stop flag");
        assert!(safe_payload.skip_if_active_jobs);
        assert!(safe_payload.require_provider_release);
        let runtime_id_string = runtime_id.to_string();
        assert_eq!(
            safe_payload.expected_project_id.as_deref(),
            Some(runtime_id_string.as_str())
        );
        assert_eq!(
            safe_payload.expected_provider.as_deref(),
            Some("instafy-cloud")
        );
        assert_eq!(
            safe_payload.expected_display_name.as_deref(),
            Some("Hosted Runtime")
        );
    }

    #[test]
    fn expected_runtime_identity_matches_all_supplied_fields() {
        let runtime = runtime_details("ready", None);
        let matching = RuntimeIdentityExpectation {
            project_id: Some(runtime.project_id),
            provider: Some("instafy-cloud".to_string()),
            display_name: Some("Hosted Runtime".to_string()),
        };
        assert!(runtime_matches_expected_identity(&runtime, &matching));

        for mismatched in [
            RuntimeIdentityExpectation {
                project_id: Some(Uuid::new_v4()),
                provider: None,
                display_name: None,
            },
            RuntimeIdentityExpectation {
                project_id: None,
                provider: Some("docker".to_string()),
                display_name: None,
            },
            RuntimeIdentityExpectation {
                project_id: None,
                provider: None,
                display_name: Some("Browser session".to_string()),
            },
        ] {
            assert!(!runtime_matches_expected_identity(&runtime, &mismatched));
        }
    }

    #[test]
    fn runtime_stop_response_reports_changed_and_skipped_outcomes() {
        let skipped = StopOutcome {
            runtime_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            status_changed: false,
            requeued_jobs: Vec::new(),
            failed_personal_browser_jobs: Vec::new(),
            failed_shared_browser_jobs: Vec::new(),
            skip_reason: Some("active_jobs".to_string()),
            released_runtime_lease_id: None,
        };
        let skipped_response = RuntimeStopResponse::from_outcome(&skipped);
        assert_eq!(
            skipped_response,
            RuntimeStopResponse {
                ok: true,
                status_changed: false,
                provider_release_attempted: false,
                provider_release_succeeded: false,
                skip_reason: Some("active_jobs".to_string()),
            }
        );
        assert_eq!(
            serde_json::to_value(&skipped_response).expect("serialize skipped response"),
            json!({
                "ok": true,
                "status_changed": false,
                "provider_release_attempted": false,
                "provider_release_succeeded": false,
                "skip_reason": "active_jobs"
            })
        );

        let changed = StopOutcome {
            status_changed: true,
            skip_reason: None,
            ..skipped
        };
        assert_eq!(
            serde_json::to_value(RuntimeStopResponse::from_outcome(&changed))
                .expect("serialize changed response"),
            json!({
                "ok": true,
                "status_changed": true,
                "provider_release_attempted": false,
                "provider_release_succeeded": false
            })
        );
    }

    fn test_state_with_provider(endpoint: Option<String>) -> crate::AppState {
        let manager = PostgresConnectionManager::new_from_stringlike(
            "postgres://postgres:postgres@127.0.0.1:1/postgres",
            NoTls,
        )
        .expect("test postgres manager");
        let pool = Pool::builder().max_size(1).build_unchecked(manager);
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "runtime-stop-provider-release",
        );
        config.runtime_providers = vec![RuntimeProviderConfig {
            id: "instafy_cloud".to_string(),
            display_name: "Instafy Cloud".to_string(),
            kind: "docker".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint,
            auth_token: None,
            metadata: None,
        }];
        build_test_state(pool, config)
    }

    fn changed_outcome(runtime: &RuntimeDetails) -> StopOutcome {
        StopOutcome {
            runtime_id: runtime.id,
            project_id: runtime.project_id,
            status_changed: true,
            requeued_jobs: Vec::new(),
            failed_personal_browser_jobs: Vec::new(),
            failed_shared_browser_jobs: Vec::new(),
            skip_reason: None,
            released_runtime_lease_id: None,
        }
    }

    #[tokio::test]
    async fn project_stop_releases_pool_connection_before_tunnel_revoke() -> anyhow::Result<()> {
        let Some(setup_pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping pool-size-one runtime stop test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        drop(setup_pool);

        let database_url = std::env::var("TEST_DATABASE_URL")?;
        let manager = PostgresConnectionManager::new_from_stringlike(&database_url, NoTls)?;
        let pool = Pool::builder().max_size(1).build(manager).await?;
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();

        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into projects (id, project_type, status)
                     values ($1, 'customer', 'active')",
                    &[&project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runtimes
                        (id, project_id, provider, status, endpoint_url,
                         idle_ttl_seconds, last_seen_at)
                     values ($1, $2, 'self-hosted', 'ready',
                             'http://127.0.0.1:3000', 600, now())",
                    &[&runtime_id, &project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runtime_leases
                        (id, project_id, runtime_id, status, requested_at, launched_at)
                     values ($1, $2, $3, 'active', now(), now())",
                    &[&lease_id, &project_id, &runtime_id],
                )
                .await?;
            connection
                .execute(
                    "update runtimes set active_lease_id = $2 where id = $1",
                    &[&runtime_id, &lease_id],
                )
                .await?;
        }

        let state = build_test_state(
            pool.clone(),
            build_app_config(
                test_origin_private_key(),
                test_origin_public_key(),
                "pool-size-one-runtime-stop",
            ),
        );
        let response = timeout(
            Duration::from_secs(5),
            super::stop_runtime_for_project(
                &state,
                &project_id,
                &runtime_id,
                Some("pool_size_one_test".to_string()),
                "pool_size_one_test",
            ),
        )
        .await
        .expect("runtime stop deadlocked while tunnel revocation waited for the sole connection")
        .map_err(|(status, body)| anyhow::anyhow!("{status}: {}", body.0.message))?;
        assert!(response.status_changed);

        {
            let connection = pool.get().await?;
            let row = connection
                .query_one(
                    "select status, active_lease_id from runtimes where id = $1",
                    &[&runtime_id],
                )
                .await?;
            assert_eq!(row.get::<_, String>("status"), "stopped");
            assert!(row.get::<_, Option<Uuid>>("active_lease_id").is_none());
            connection
                .execute("delete from projects where id = $1", &[&project_id])
                .await?;
        }

        Ok(())
    }

    #[tokio::test]
    async fn strict_provider_release_reports_provider_acceptance() {
        let server = MockServer::start_async().await;
        let release_mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/runtime/release");
                then.status(204);
            })
            .await;
        let state = test_state_with_provider(Some(server.base_url()));
        let runtime = runtime_details("ready", None);
        let lease_id = Uuid::new_v4();
        let provider = state
            .provider_registry
            .provider_config(&runtime.provider)
            .expect("test provider");

        let release = release_runtime_via_resolved_provider(
            &state,
            &runtime,
            &lease_id,
            &provider,
            "test failure",
        )
        .await;
        let (status, response) =
            build_runtime_stop_response(&changed_outcome(&runtime), &release, true);

        assert_eq!(status, StatusCode::OK);
        assert!(response.ok);
        assert!(response.provider_release_attempted);
        assert!(response.provider_release_succeeded);
        release_mock.assert_async().await;
    }

    #[tokio::test]
    async fn strict_provider_release_failure_is_a_sanitized_bad_gateway() {
        let server = MockServer::start_async().await;
        let release_mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/runtime/release");
                then.status(500)
                    .body("sensitive provider deployment detail");
            })
            .await;
        let state = test_state_with_provider(Some(server.base_url()));
        let runtime = runtime_details("ready", None);
        let lease_id = Uuid::new_v4();
        let provider = state
            .provider_registry
            .provider_config(&runtime.provider)
            .expect("test provider");

        let release = release_runtime_via_resolved_provider(
            &state,
            &runtime,
            &lease_id,
            &provider,
            "test failure",
        )
        .await;
        let (status, response) =
            build_runtime_stop_response(&changed_outcome(&runtime), &release, true);
        let serialized = serde_json::to_string(&response).expect("serialize response");

        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(!response.ok);
        assert!(response.provider_release_attempted);
        assert!(!response.provider_release_succeeded);
        assert!(!serialized.contains("sensitive provider deployment detail"));
        release_mock.assert_async().await;
    }

    #[tokio::test]
    async fn strict_provider_release_reports_missing_provider_without_attempting() {
        let state = test_state_with_provider(None);
        state.provider_registry.replace(
            std::collections::HashMap::from([(
                "default".to_string(),
                RuntimeProviderConfig {
                    id: "default".to_string(),
                    display_name: "Default".to_string(),
                    kind: "docker".to_string(),
                    owner_org_id: None,
                    allowed_org_ids: vec![],
                    endpoint: Some("http://127.0.0.1:1".to_string()),
                    auth_token: None,
                    metadata: None,
                },
            )]),
            "default".to_string(),
        );
        let runtime = runtime_details("ready", None);
        let lease_id = Uuid::new_v4();

        let release =
            release_runtime_via_provider(&state, &runtime, Some(&lease_id), "test failure").await;
        let (status, response) =
            build_runtime_stop_response(&changed_outcome(&runtime), &release, true);

        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(!response.ok);
        assert!(!response.provider_release_attempted);
        assert!(!response.provider_release_succeeded);
    }

    #[tokio::test]
    async fn strict_provider_release_reports_missing_endpoint_without_attempting() {
        let state = test_state_with_provider(None);
        let runtime = runtime_details("ready", None);
        let lease_id = Uuid::new_v4();
        let provider = state
            .provider_registry
            .provider_config(&runtime.provider)
            .expect("test provider");

        let release = release_runtime_via_resolved_provider(
            &state,
            &runtime,
            &lease_id,
            &provider,
            "test failure",
        )
        .await;
        let (status, response) =
            build_runtime_stop_response(&changed_outcome(&runtime), &release, true);

        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(!response.ok);
        assert!(!response.provider_release_attempted);
        assert!(!response.provider_release_succeeded);
    }

    #[test]
    fn legacy_provider_release_failure_remains_best_effort() {
        let runtime = runtime_details("ready", None);
        let release = ProviderReleaseOutcome {
            attempted: true,
            succeeded: false,
        };
        let (status, response) =
            build_runtime_stop_response(&changed_outcome(&runtime), &release, false);

        assert_eq!(status, StatusCode::OK);
        assert!(response.ok);
        assert!(response.provider_release_attempted);
        assert!(!response.provider_release_succeeded);
    }
}

#[derive(Deserialize)]
pub(crate) struct RuntimeOfflineBody {
    pub runtime_id: String,
}

#[instrument(skip(state, headers, body))]
pub(crate) async fn runtime_mark_offline(
    axum::extract::State(state): axum::extract::State<AppState>,
    Path(project_id_raw): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RuntimeOfflineBody>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    if !state.config.dev_mode {
        return Err(forbidden(
            "Offline simulation endpoint is disabled outside dev mode.",
        ));
    }

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("project_id must be a valid UUID"))?;
    let runtime_id = Uuid::from_str(body.runtime_id.trim())
        .map_err(|_| bad_request("runtime_id must be a valid UUID"))?;

    let auth_context = authenticate_request(&state.config, &headers, None).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_write_access(&transaction, &project, &auth_context, None).await?;

    let runtime = fetch_runtime_for_update(&transaction, &runtime_id).await?;
    if runtime.project_id != project_id {
        return Err(not_found("Runtime not found for project."));
    }
    super::access::ensure_self_hosted_runtime_access(
        &state,
        &runtime.provider,
        &runtime.capabilities,
        auth_context.user_id,
        auth_context.is_service_role,
    )?;
    let runtime_provider = runtime.provider.clone();

    // Offline is terminal for a device-local Personal Browser target. Resolve
    // bindings in the same transaction instead of leaving them for delayed
    // terminal-record cleanup.
    resolve_jobs_for_unavailable_runtime(&transaction, &runtime, "dev_runtime_offline").await?;

    let rows_updated = transaction
        .execute(
            "update runtimes set status = 'offline', last_seen_at = now(), idle_ttl_seconds = 1 \
             where id = $1 and project_id = $2",
            &[&runtime_id, &project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update runtime status: {error}")))?;

    if rows_updated == 0 {
        return Err(not_found("Runtime not found for project."));
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize runtime offline update: {error}"
        ))
    })?;

    publish_controller_event(
        &state.events,
        "runtime.stopped",
        Some(project_id),
        None,
        Some(runtime_id),
        None,
        json!({
            "runtimeId": runtime_id,
            "status": "offline",
            "source": "dev.offline"
        }),
    );

    if let Some(provider_cfg) = state.provider_registry.provider_config(&runtime_provider) {
        if let Err(error) = call_provider_endpoint(
            &state,
            &provider_cfg,
            "/runtime/release",
            &ProviderReleaseRequest {
                project_id: &project_id,
                runtime_id: &runtime_id,
                lease_id: runtime.active_lease_id.as_ref(),
            },
        )
        .await
        {
            warn!(
                runtime_id = %runtime_id,
                project_id = %project_id,
                %error,
                "failed to stop runtime via provider from dev offline endpoint"
            );
        }
    }

    Ok(StatusCode::NO_CONTENT)
}
