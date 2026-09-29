use std::str::FromStr;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio::sync::Semaphore;
use tokio_postgres::Transaction;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use crate::auth::{authenticate_request, RequestContext};
use crate::bug_reports::{record_system_bug_report, SystemBugReportInput};
use crate::org_limits;
use crate::projects::ensure_project_org;
use crate::tokens::{mint_scoped_token, MintedAccessToken, ScopedTokenRequest};
use crate::tunnels::{request_runtime_tunnel, TunnelGrantResponse};
use crate::{
    bad_request, coerce_idle_ttl, database_unavailable, ensure_project_write_access, forbidden,
    internal_error, load_project_record, not_found, parse_optional_uuid_param, too_many_requests,
    unauthorized, ApiError, AppState,
};

use super::db::{
    create_runtime_lease, ensure_project_exists, ensure_runtime_record, fetch_runtime_for_update,
    fetch_runtime_lease_for_update, load_origin_instance_for_lease, mark_runtime_lease_active,
    mark_runtime_lease_launching, mark_runtime_lease_released, record_runtime_event,
    release_origin_instances_for_runtime, release_tenant_leases_of_parent,
    runtime_provider_identity_matches, upsert_origin_instance, OriginInstanceRecord,
    RuntimeDetails, RuntimeLeaseDetails, RuntimeLeaseRecord, RuntimeRecord,
};
use super::lease::{parse_lease_scope, RuntimeLeaseScope};
use super::limit_waits::{
    is_runtime_limit_refusal, record_hosted_runtime_limit_refusal, LimitWaitEnsureRequest,
    LimitWaitSource,
};
use super::provider::{
    apply_browser_profile_persistence_policy, apply_controller_turn_credentials,
    apply_git_remote_env, authorize_provider_config_for_project, authorize_provider_for_project,
    call_provider_endpoint, lock_and_load_authoritative_provider_config, merge_provider_metadata,
    ProviderEnsureRequest, ProviderReleaseRequest,
};
use super::stop::{stop_runtime_for_project, stop_runtime_safely, StopOptions};
use super::token::default_runtime_token_scopes;
use super::utils::normalize_display_name_owned;

// The runtime/lease/project fence below deliberately spans the provider ensure
// call so stop or project deletion cannot overtake a launch and leave a
// recreated container.
// Keep that external I/O bounded: a provider that stops responding must not
// retain a Postgres pool connection and row lock indefinitely.
const RUNTIME_PROVIDER_ENSURE_FENCE_TIMEOUT: Duration = Duration::from_secs(120);
// Waiters stay outside the database pool. Only one controller request per
// process may hold the runtime/lease/project launch fence across provider I/O.
// A capacity of one leaves a connection available for stop/recovery even when
// the controller pool is configured with only two connections.
static RUNTIME_PROVIDER_ENSURE_FENCE_CAPACITY: Semaphore = Semaphore::const_new(1);
const RUNTIME_PROVIDER_COMPENSATING_RELEASE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
// An idle-slot reclaim runs inside the waiting launch's provider admission,
// which serializes every provider launch in this process. Its provider release
// is already bounded (RUNTIME_PROVIDER_RELEASE_TIMEOUT); the tunnel broker
// revoke that follows must be too. Giving up has the same effect as a broker
// error: the stopped runtime's local grants stay active until they expire.
const RECLAIM_TUNNEL_REVOKE_TIMEOUT: Duration = Duration::from_secs(15);
/// Stop reason and source of an idle-slot reclaim, recorded on the stop event
/// and published on `runtime.stopped`.
pub(super) const RUNTIME_LIMIT_RECLAIM_STOP_REASON: &str = "runtime_limit_reclaim";

#[cfg(test)]
#[derive(Clone)]
struct ProviderLaunchAdmissionTestHook {
    reached: std::sync::Arc<tokio::sync::Notify>,
    proceed: std::sync::Arc<tokio::sync::Notify>,
    waiting: std::sync::Arc<tokio::sync::Notify>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RuntimeEnsurePayload {
    pub(crate) project_id: String,
    #[serde(default)]
    pub(crate) provider: Option<String>,
    #[serde(default, rename = "idleTtlSeconds", alias = "idle_ttl_seconds")]
    pub(crate) idle_ttl_seconds: Option<u32>,
    #[serde(default)]
    pub(crate) metadata: Option<JsonValue>,
    #[serde(default, rename = "displayName", alias = "display_name")]
    pub(crate) display_name: Option<String>,
    #[serde(default)]
    pub(crate) scope: Option<String>,
    #[serde(default, rename = "runtimeId", alias = "runtime_id")]
    pub(crate) runtime_id: Option<String>,
    #[serde(default, rename = "originMode", alias = "origin_mode")]
    pub(crate) origin_mode: Option<String>,
    #[serde(default, rename = "originProtocols", alias = "origin_protocols")]
    pub(crate) origin_protocols: Option<Vec<String>>,
    #[serde(default, rename = "originMetadata", alias = "origin_metadata")]
    pub(crate) origin_metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeEnsureResponse {
    pub(crate) runtime_id: String,
    pub(crate) status: String,
    pub(crate) provider: String,
    #[serde(rename = "leaseId")]
    pub(crate) lease_id: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "parentLeaseId")]
    pub(crate) parent_lease_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) origin: Option<RuntimeEnsureOriginInfo>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeEnsureOriginInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) origin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) lease_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) mode: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) protocols: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<JsonValue>,
}

#[derive(Clone, Debug)]
pub(super) struct OriginEnsureOptions {
    mode: Option<String>,
    protocols: Vec<String>,
    metadata: Option<JsonValue>,
}

impl OriginEnsureOptions {
    pub(super) fn new(
        mode: Option<String>,
        protocols: Option<Vec<String>>,
        metadata: Option<JsonValue>,
    ) -> Self {
        let normalized_mode = mode
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty());
        let mut normalized_protocols = protocols.unwrap_or_default();
        normalized_protocols = normalized_protocols
            .into_iter()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect();
        if normalized_protocols.is_empty() {
            normalized_protocols.push("http".to_string());
        }
        normalized_protocols.sort();
        normalized_protocols.dedup();
        Self {
            mode: normalized_mode,
            protocols: normalized_protocols,
            metadata,
        }
    }
}

fn origin_info_from_record(record: &OriginInstanceRecord) -> RuntimeEnsureOriginInfo {
    RuntimeEnsureOriginInfo {
        status: Some(record.status.clone()),
        origin_id: record.origin_id.map(|value| value.to_string()),
        lease_id: record.lease_id.map(|value| value.to_string()),
        mode: record.mode.clone(),
        protocols: record.protocols.clone(),
        endpoint: record.endpoint.clone(),
        metadata: record.metadata.clone(),
    }
}

/// Revalidate and lock the project at a runtime-launch ordering boundary.
///
/// Runtime access is authorized before `ensure_runtime_launch` starts, but a
/// project can be tombstoned while the allocation transaction is creating its
/// runtime and lease rows. `FOR SHARE` makes that race deterministic: an
/// already-running tombstone update wins and becomes visible here, while a
/// later tombstone must wait until the caller finishes the protected operation.
/// Callers use this once at allocation commit and again while the provider
/// ensure request is in flight, so a delete cannot commit and release the
/// runtime before the provider finishes creating it.
async fn ensure_project_available_for_runtime_launch(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select status from projects where id = $1 for share",
            &[project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to revalidate project before runtime launch: {error}"
            ))
        })?;

    let Some(row) = row else {
        return Err(not_found("project not found"));
    };
    let status: Option<String> = row.get("status");
    if status
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("deleted"))
        .unwrap_or(false)
    {
        return Err(not_found("project not found"));
    }

    Ok(())
}

fn runtime_launch_is_no_longer_current() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::CONFLICT,
        Json(ApiError::new("runtime launch is no longer current")),
    )
}

/// Lock and revalidate the allocation identity before contacting a provider.
///
/// Lock order is deliberately runtime -> lease -> project (the project lock is
/// acquired by `ensure_project_available_for_runtime_launch` immediately after
/// this helper). Runtime stop follows the same runtime -> lease order, so it
/// either completes before this validation and makes the launch stale, or waits
/// until provider ensure has completed. In particular, a stopped/released lease
/// must never be resurrected by a delayed provider request.
async fn ensure_runtime_lease_available_for_provider_launch(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: &Uuid,
    expected_provider: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let runtime = fetch_runtime_for_update(transaction, runtime_id).await?;
    if runtime.project_id != *project_id
        || runtime.provider != expected_provider
        || runtime.active_lease_id != Some(*lease_id)
        || matches!(runtime.status.as_str(), "stopped" | "removed" | "offline")
    {
        return Err(runtime_launch_is_no_longer_current());
    }

    let lease = fetch_runtime_lease_for_update(transaction, lease_id).await?;
    if lease.project_id != *project_id
        || lease.runtime_id != Some(*runtime_id)
        || lease.released_at.is_some()
        || !matches!(lease.status.as_str(), "launching" | "active")
    {
        return Err(runtime_launch_is_no_longer_current());
    }

    Ok(())
}

/// Quarantine an ambiguous provider launch before releasing the launch fence.
///
/// A provider request can time out after it has already created compute. While
/// the runtime/lease rows are still locked, move the exact allocation into a
/// non-registerable, non-reusable lease state. This closes the window where a
/// late runtime registration or a second ensure could otherwise make the
/// ambiguous launch usable before its compensating release completes.
async fn mark_runtime_launch_cleanup_pending(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: &Uuid,
    expected_provider: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    ensure_runtime_lease_available_for_provider_launch(
        transaction,
        project_id,
        runtime_id,
        lease_id,
        expected_provider,
    )
    .await?;

    let lease_rows = transaction
        .execute(
            "update runtime_leases
             set status = 'cleanup_pending',
                 updated_at = now()
             where id = $1
               and project_id = $2
               and runtime_id = $3
               and released_at is null
               and status in ('launching', 'active')",
            &[lease_id, project_id, runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to quarantine ambiguous runtime launch: {error}"
            ))
        })?;
    if lease_rows != 1 {
        return Err(runtime_launch_is_no_longer_current());
    }

    let runtime_rows = transaction
        .execute(
            "update runtimes
             set status = 'requested',
                 endpoint_url = null,
                 task_ref = null,
                 last_seen_at = null,
                 updated_at = now()
             where id = $1
               and project_id = $2
               and provider = $3
               and active_lease_id = $4
               and status not in ('stopped', 'removed', 'offline')",
            &[runtime_id, project_id, &expected_provider, lease_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to quarantine ambiguous runtime record: {error}"
            ))
        })?;
    if runtime_rows != 1 {
        return Err(runtime_launch_is_no_longer_current());
    }

    record_runtime_event(
        transaction,
        runtime_id,
        project_id,
        "launch_cleanup_pending",
        json!({
            "reason": "provider_ensure_failed",
            "provider": expected_provider,
            "runtimeLeaseId": lease_id,
        }),
    )
    .await?;

    Ok(())
}

/// Best-effort retry for the quarantine transition when committing the
/// in-fence transition failed. A concurrent stop is authoritative, so stale
/// allocations report `false` instead of being rewritten.
async fn mark_runtime_launch_cleanup_pending_if_current(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: &Uuid,
    expected_provider: &str,
) -> anyhow::Result<bool> {
    let mut connection = state.pool.get().await.map_err(|error| {
        anyhow::anyhow!("failed to acquire launch-quarantine connection: {error}")
    })?;
    let transaction = connection.transaction().await.map_err(|error| {
        anyhow::anyhow!("failed to start launch-quarantine transaction: {error}")
    })?;

    match mark_runtime_launch_cleanup_pending(
        &transaction,
        project_id,
        runtime_id,
        lease_id,
        expected_provider,
    )
    .await
    {
        Ok(()) => {}
        Err((StatusCode::CONFLICT | StatusCode::NOT_FOUND, _)) => {
            transaction.rollback().await.map_err(|error| {
                anyhow::anyhow!("failed to roll back stale launch-quarantine transaction: {error}")
            })?;
            return Ok(false);
        }
        Err((status, payload)) => {
            return Err(anyhow::anyhow!(
                "failed to quarantine runtime launch ({status}): {}",
                payload.0.message
            ));
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| anyhow::anyhow!("failed to commit runtime launch quarantine: {error}"))?;
    Ok(true)
}

/// Mark a failed launch only while the exact runtime/lease allocation is still
/// current. This is intentionally separate from the general lease-failure
/// helper: provider compensation happens after releasing the launch fence, so
/// a user stop can win that interval. If it does, the released lease and stopped
/// runtime are authoritative and must not be rewritten to `failed`.
async fn mark_runtime_launch_failed_if_current(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: &Uuid,
    expected_provider: &str,
) -> anyhow::Result<bool> {
    let mut connection =
        state.pool.get().await.map_err(|error| {
            anyhow::anyhow!("failed to acquire launch-failure connection: {error}")
        })?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| anyhow::anyhow!("failed to start launch-failure transaction: {error}"))?;

    let runtime = match fetch_runtime_for_update(&transaction, runtime_id).await {
        Ok(runtime) => runtime,
        Err((StatusCode::NOT_FOUND, _)) => {
            transaction.rollback().await.map_err(|error| {
                anyhow::anyhow!("failed to roll back stale launch-failure transaction: {error}")
            })?;
            return Ok(false);
        }
        Err((status, payload)) => {
            return Err(anyhow::anyhow!(
                "failed to lock runtime launch before marking it failed ({status}): {}",
                payload.0.message
            ));
        }
    };
    if runtime.project_id != *project_id
        || runtime.provider != expected_provider
        || runtime.active_lease_id != Some(*lease_id)
        || matches!(runtime.status.as_str(), "stopped" | "removed" | "offline")
    {
        transaction.rollback().await.map_err(|error| {
            anyhow::anyhow!("failed to roll back stale launch-failure transaction: {error}")
        })?;
        return Ok(false);
    }

    let lease = match fetch_runtime_lease_for_update(&transaction, lease_id).await {
        Ok(lease) => lease,
        Err((StatusCode::NOT_FOUND, _)) => {
            transaction.rollback().await.map_err(|error| {
                anyhow::anyhow!("failed to roll back stale launch-failure transaction: {error}")
            })?;
            return Ok(false);
        }
        Err((status, payload)) => {
            return Err(anyhow::anyhow!(
                "failed to lock runtime lease before marking it failed ({status}): {}",
                payload.0.message
            ));
        }
    };
    if lease.project_id != *project_id
        || lease.runtime_id != Some(*runtime_id)
        || lease.released_at.is_some()
        || !matches!(
            lease.status.as_str(),
            "launching" | "active" | "cleanup_pending"
        )
    {
        transaction.rollback().await.map_err(|error| {
            anyhow::anyhow!("failed to roll back stale launch-failure transaction: {error}")
        })?;
        return Ok(false);
    }

    let lease_rows = transaction
        .execute(
            "update runtime_leases
             set status = 'failed',
                 released_at = now(),
                 updated_at = now()
             where id = $1
               and project_id = $2
               and runtime_id = $3
               and released_at is null
               and status in ('launching', 'active', 'cleanup_pending')",
            &[lease_id, project_id, runtime_id],
        )
        .await
        .map_err(|error| anyhow::anyhow!("failed to mark runtime launch lease failed: {error}"))?;
    if lease_rows != 1 {
        transaction.rollback().await.map_err(|error| {
            anyhow::anyhow!("failed to roll back stale launch-failure transaction: {error}")
        })?;
        return Ok(false);
    }
    release_tenant_leases_of_parent(&transaction, lease_id)
        .await
        .map_err(|(_, payload)| {
            anyhow::anyhow!(
                "failed to release tenant leases after launch failure: {}",
                payload.0.message
            )
        })?;

    let runtime_rows = transaction
        .execute(
            "update runtimes
             set status = 'stopped',
                 endpoint_url = null,
                 task_ref = null,
                 last_seen_at = now(),
                 active_lease_id = null,
                 updated_at = now()
             where id = $1
               and project_id = $2
               and provider = $3
               and active_lease_id = $4
               and status not in ('stopped', 'removed', 'offline')",
            &[runtime_id, project_id, &expected_provider, lease_id],
        )
        .await
        .map_err(|error| anyhow::anyhow!("failed to stop runtime after launch failure: {error}"))?;
    if runtime_rows != 1 {
        transaction.rollback().await.map_err(|error| {
            anyhow::anyhow!("failed to roll back stale launch-failure transaction: {error}")
        })?;
        return Ok(false);
    }

    release_origin_instances_for_runtime(&transaction, runtime_id)
        .await
        .map_err(|(_, payload)| {
            anyhow::anyhow!(
                "failed to release runtime origins after launch failure: {}",
                payload.0.message
            )
        })?;
    record_runtime_event(
        &transaction,
        runtime_id,
        project_id,
        "stopped",
        json!({
            "reason": "lease_failed",
            "provider": expected_provider,
            "runtimeLeaseId": lease_id,
        }),
    )
    .await
    .map_err(|(_, payload)| {
        anyhow::anyhow!(
            "failed to record runtime stop after launch failure: {}",
            payload.0.message
        )
    })?;

    transaction
        .commit()
        .await
        .map_err(|error| anyhow::anyhow!("failed to commit runtime launch failure: {error}"))?;
    Ok(true)
}

#[derive(Debug, Clone)]
struct ActiveHostedRuntimeBlocker {
    runtime_id: Uuid,
    project_id: Uuid,
    project_name: Option<String>,
    display_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostedRuntimeLimitDetails {
    active_count: i64,
    max_active_count: i64,
    blocker_runtime_id: Option<String>,
    blocker_project_id: Option<String>,
    blocker_runtime_label: Option<String>,
    blocker_project_label: Option<String>,
}

/// Advisory-lock key serializing an organization's hosted runtime admission
/// (the limit count and the lease insert that follows it) across replicas.
pub(super) fn hosted_runtime_admission_lock_key(org_id: &Uuid) -> String {
    format!("hosted-runtime-admission:{org_id}")
}

/// Hold the organization's hosted runtime admission until `transaction` ends.
/// Callers must not wait on anything but the database while it is held.
async fn lock_hosted_runtime_admission(
    transaction: &Transaction<'_>,
    org_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&hosted_runtime_admission_lock_key(org_id)],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to serialize the organization's hosted runtime admission: {error}"
            ))
        })?;
    Ok(())
}

/// Whether a new hosted runtime should be refused on platform capacity.
/// `cap <= 0` disables the gate. `active < 0` signals a failed count and fails
/// OPEN (never blocks), so a transient DB error can't lock everyone out.
fn platform_at_capacity(active_count: i64, cap: i64) -> bool {
    cap > 0 && active_count >= cap
}

fn hosted_runtime_limit_details(
    active_count: i64,
    max_active_hosted_runtimes: i64,
    blocker: Option<&ActiveHostedRuntimeBlocker>,
) -> HostedRuntimeLimitDetails {
    HostedRuntimeLimitDetails {
        active_count,
        max_active_count: max_active_hosted_runtimes,
        blocker_runtime_id: blocker.map(|value| value.runtime_id.to_string()),
        blocker_project_id: blocker.map(|value| value.project_id.to_string()),
        blocker_runtime_label: blocker
            .and_then(|value| value.display_name.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        blocker_project_label: blocker
            .and_then(|value| value.project_name.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
    }
}

/// The 402 a space gets when the organization's hosted runtimes are all in use.
/// Shared so that a reclaim attempt which did not free the slot refuses with
/// exactly the same payload as one that was never tried.
fn hosted_runtime_limit_refusal(
    active_count: i64,
    max_active_hosted_runtimes: i64,
    blocker: Option<&ActiveHostedRuntimeBlocker>,
) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::PAYMENT_REQUIRED,
        Json(ApiError::with_details(
            format_hosted_runtime_limit_message(active_count, max_active_hosted_runtimes, blocker),
            "runtime_limit_reached",
            serde_json::to_value(hosted_runtime_limit_details(
                active_count,
                max_active_hosted_runtimes,
                blocker,
            ))
            .unwrap_or_else(|_| json!({})),
        )),
    )
}

fn format_hosted_runtime_limit_message(
    active_count: i64,
    max_active_hosted_runtimes: i64,
    blocker: Option<&ActiveHostedRuntimeBlocker>,
) -> String {
    let mut message = format!(
        "Instafy Cloud runtime limit reached for this organization ({active_count} active; max {max_active_hosted_runtimes})."
    );

    if let Some(blocker) = blocker {
        let runtime_label = blocker
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Instafy Cloud runtime");
        let project_label = blocker
            .project_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| blocker.project_id.to_string());

        message.push_str(&format!(
            " Active runtime \"{runtime_label}\" is attached to project \"{project_label}\" (project {}, runtime {}). Stop/remove that runtime, then retry.",
            blocker.project_id, blocker.runtime_id
        ));
    } else {
        message.push_str(" Stop another runtime or upgrade your plan.");
    }

    message
}

async fn load_active_hosted_runtime_blocker(
    transaction: &Transaction<'_>,
    org_id: &Uuid,
    current_project_id: &Uuid,
) -> Result<Option<ActiveHostedRuntimeBlocker>, tokio_postgres::Error> {
    let row = transaction
        .query_opt(
            "select r.id as runtime_id,
                    r.project_id as project_id,
                    p.name as project_name,
                    r.display_name as display_name
             from runtimes r
             join projects p on p.id = r.project_id
             join runtime_leases rl on rl.id = r.active_lease_id
             where p.org_id = $1
               and (
                 r.provider = 'instafy_cloud'
                 or r.provider like 'instafy\\_cloud\\_%'
                 or r.provider = 'instafy-cloud'
                 or r.provider like 'instafy-cloud-%'
               )
               and r.active_lease_id is not null
               and r.status not in ('stopped', 'removed')
               and rl.released_at is null
               and rl.status <> 'failed'
             order by (r.project_id = $2) asc, r.updated_at desc nulls last
             limit 1",
            &[org_id, current_project_id],
        )
        .await?;

    Ok(row.map(|record| ActiveHostedRuntimeBlocker {
        runtime_id: record.get("runtime_id"),
        project_id: record.get("project_id"),
        project_name: record.get("project_name"),
        display_name: record.get("display_name"),
    }))
}

/// Whether the runtime currently holding the organization's last hosted slot
/// can be handed to a space that is waiting for it.
///
/// Every signal is durable (database) and every one of them is a reason to
/// refuse: the in-memory activity tracker cannot prove idleness, and being
/// wrong here means stopping a machine somebody is using. Mirrors the idle
/// sweep's predicate (`auto_stop_idle_hosted_runtimes`) and adds the two
/// conditions a demand-driven reclaim needs on top of it — a settled runtime
/// rather than one that is still booting, and no queued work waiting for it.
async fn hosted_runtime_blocker_is_reclaimable(
    transaction: &Transaction<'_>,
    runtime_id: &Uuid,
    idle_seconds: i64,
) -> bool {
    let row = transaction
        .query_one(
            "select exists (
               select 1
               from runtimes r
               join runtime_leases rl on rl.id = r.active_lease_id
               where r.id = $1
                 -- Settled and serving. A requested/launching generation may
                 -- have a launch in flight at the provider; stopping it races
                 -- that launch and can strand a cleanup_pending lease.
                 and r.status in ('ready', 'running')
                 and rl.released_at is null
                 and rl.status = 'active'
                 -- Boot grace, measured on the lease rather than the runtime
                 -- row, which is reused across wake cycles.
                 and coalesce(rl.launched_at, rl.requested_at, r.created_at)
                     < now() - interval '1 second' * $2
                 -- Nothing leased on the machine itself.
                 and not exists (
                   select 1 from agent_jobs j
                   where j.leased_by_runtime_id = r.id and j.status = 'leased'
                 )
                 -- Nothing waiting to be picked up in that space, and nothing
                 -- pinned to this machine. The idle sweep has no equivalent:
                 -- it only looks at recency, so it would reclaim a runtime
                 -- whose owner pressed send a moment ago.
                 and not exists (
                   select 1 from agent_jobs j
                   where j.status in ('queued', 'leased')
                     and (j.project_id = r.project_id or j.target_runtime_id = r.id)
                 )
                 -- No open turn someone is watching.
                 and not exists (
                   select 1 from runs u
                   where u.project_id = r.project_id
                     and u.status in ('queued', 'in_progress', 'awaiting_approval')
                 )
                 -- No recent agent work in that space.
                 and not exists (
                   select 1 from agent_jobs j
                   where j.project_id = r.project_id
                     and greatest(
                       coalesce(j.updated_at, to_timestamp(0)),
                       coalesce(j.heartbeat_at, to_timestamp(0)),
                       coalesce(j.leased_at, to_timestamp(0))
                     ) > now() - interval '1 second' * $2
                 )
                 -- Nobody sitting in that space right now.
                 and not exists (
                   select 1 from project_user_activity a
                   where a.project_id = r.project_id
                     and a.last_active_at > now() - interval '1 second' * $2
                 )
             ) as reclaimable",
            &[runtime_id, &(idle_seconds as f64)],
        )
        .await;

    match row {
        Ok(row) => row.get("reclaimable"),
        Err(error) => {
            // Fails CLOSED, unlike the org cap count above: refusing the
            // launch only asks the user to stop the machine themselves, while
            // reclaiming on an unproven predicate interrupts someone's work.
            // Schema lag (project_user_activity) lands here too.
            warn!(
                runtime_id = %runtime_id,
                error = ?error,
                "could not prove the blocking hosted runtime is idle; not reclaiming it"
            );
            false
        }
    }
}

/// Stop an idle blocking runtime so the waiting space can have the slot.
///
/// Returns whether the slot was actually released. Must be called with no
/// allocation transaction open: the stop takes its own pool connection and
/// then waits on the provider's release endpoint over the network. The caller
/// still holds the provider launch admission, so every external call in here
/// is bounded: the release by `RUNTIME_PROVIDER_RELEASE_TIMEOUT` and the
/// tunnel revoke by `RECLAIM_TUNNEL_REVOKE_TIMEOUT`.
async fn reclaim_idle_hosted_runtime_blocker(
    state: &AppState,
    blocker: &ActiveHostedRuntimeBlocker,
) -> bool {
    let stop_options = StopOptions {
        source: RUNTIME_LIMIT_RECLAIM_STOP_REASON,
        // The reason the reclaimed space's clients see on `runtime.stopped`.
        // They must not treat it as an unexpected loss and relaunch at once:
        // that would take the slot straight back from the space it was
        // handed to (see unexpectedHostedRuntimeRecovery.ts).
        reason: Some(RUNTIME_LIMIT_RECLAIM_STOP_REASON.to_string()),
        // The predicate above proved idleness a moment ago; this re-proves the
        // narrow part of it under the runtime row lock, which is the race that
        // matters. `require_idle_timeout` stays off because it measures the
        // heartbeat, not work.
        skip_if_active_jobs: true,
        require_idle_timeout: false,
        allow_cleanup_pending_release: false,
        expected_identity: None,
    };
    let stop_reason_label = stop_options
        .reason
        .clone()
        .unwrap_or_else(|| stop_options.source.to_string());

    match stop_runtime_safely(state, &blocker.runtime_id, stop_options).await {
        Ok(stopped) => {
            if let Some(skip_reason) = stopped.outcome.skip_reason.as_deref() {
                info!(
                    runtime_id = %blocker.runtime_id,
                    project_id = %blocker.project_id,
                    %skip_reason,
                    "blocking hosted runtime became busy before it could be reclaimed"
                );
                return false;
            }
            if !stopped.outcome.status_changed {
                return false;
            }

            let runtime = &stopped.runtime;
            info!(
                runtime_id = %runtime.id,
                project_id = %runtime.project_id,
                "reclaimed an idle hosted runtime for a space waiting on the organization limit"
            );
            match tokio::time::timeout(
                RECLAIM_TUNNEL_REVOKE_TIMEOUT,
                crate::tunnels::revoke_tunnels_for_scope(
                    state,
                    &runtime.project_id,
                    Some(&runtime.id),
                    stopped.outcome.released_runtime_lease_id.as_ref(),
                    &stop_reason_label,
                ),
            )
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err((status, payload))) => warn!(
                    runtime_id = %runtime.id,
                    project_id = %runtime.project_id,
                    %status,
                    error = payload.0.message,
                    "failed to revoke tunnels while reclaiming an idle hosted runtime"
                ),
                Err(_) => warn!(
                    runtime_id = %runtime.id,
                    project_id = %runtime.project_id,
                    timeout_seconds = RECLAIM_TUNNEL_REVOKE_TIMEOUT.as_secs(),
                    "timed out revoking tunnels while reclaiming an idle hosted runtime; \
                     its remaining grants stay active until they expire"
                ),
            }
            // Work can land on the blocker between the idleness check and the
            // stop; the stop requeues it. (The stop's own outcome cannot say
            // so: a provider-managed stop requeues in its quarantine phase and
            // reports only the finalization.) Count what is queued there now.
            let queued_job_count =
                match super::limit_waits::count_waiting_jobs(state, &runtime.project_id).await {
                    Ok(count) => count,
                    Err(error) => {
                        warn!(
                            runtime_id = %runtime.id,
                            project_id = %runtime.project_id,
                            ?error,
                            "could not count work left queued in a reclaimed space"
                        );
                        0
                    }
                };
            // The space that lost its machine is told, so its studio stops
            // showing a runtime that no longer exists. `queuedJobCount` tells
            // its clients whether work of theirs is waiting there, the one
            // case in which they should ask for a machine again right away.
            super::sweeps::notify_runtime_stopped_with_extra(
                state,
                runtime.project_id,
                runtime.id,
                &stop_reason_label,
                RUNTIME_LIMIT_RECLAIM_STOP_REASON,
                json!({ "queuedJobCount": queued_job_count }),
            );
            // Deliberately NOT re-ensured here, unlike the idle sweep:
            // requesting a machine for this space again would either consume
            // the slot the waiting space is about to take, or bounce off the
            // same limit. The space now waits on the limit like any other, so
            // the limit-wait sweep starts its work as soon as a runtime is
            // free, which is the behaviour the limit implies.
            if queued_job_count > 0 {
                info!(
                    runtime_id = %runtime.id,
                    project_id = %runtime.project_id,
                    queued_job_count,
                    "reclaimed a hosted runtime that had just been given work; \
                     the work waits for a free runtime"
                );
                let metadata = load_runtime_requeue_metadata(state, runtime)
                    .await
                    .ok()
                    .flatten();
                let wait_request = LimitWaitEnsureRequest {
                    provider: runtime.provider.clone(),
                    runtime_id: Some(runtime.id),
                    idle_ttl_seconds: coerce_idle_ttl(Some(runtime.idle_ttl_seconds.max(0) as u32)),
                    display_name: runtime.display_name.clone(),
                    metadata: Some(build_requeued_runtime_metadata(
                        metadata.as_ref(),
                        runtime.id,
                        RUNTIME_LIMIT_RECLAIM_STOP_REASON,
                    )),
                    scope: Some(RuntimeLeaseScope::Exclusive.as_str().to_string()),
                    origin_mode: None,
                    origin_protocols: Vec::new(),
                };
                record_hosted_runtime_limit_refusal(
                    state,
                    runtime.project_id,
                    &wait_request,
                    LimitWaitSource::Server,
                )
                .await;
            }
            true
        }
        Err((status, body)) => {
            // Includes the 502 that leaves the blocker quarantined but still
            // counted. The caller refuses the launch exactly as it would have
            // without this attempt.
            warn!(
                runtime_id = %blocker.runtime_id,
                project_id = %blocker.project_id,
                %status,
                error = body.0.message,
                "failed to reclaim an idle hosted runtime"
            );
            false
        }
    }
}

fn lease_is_reusable(lease: &RuntimeLeaseDetails) -> bool {
    lease.released_at.is_none()
        && matches!(lease.status.as_str(), "pending" | "launching" | "active")
}

async fn authorize_explicit_runtime_target(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: Option<Uuid>,
    requested_provider: &str,
    context: &RequestContext,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let Some(runtime_id) = runtime_id else {
        if super::provider::provider_is_self_hosted(state, requested_provider) {
            return Err(bad_request(
                "self-hosted runtimes must first register from their owner device",
            ));
        }
        return Ok(false);
    };

    let row = transaction
        .query_opt(
            "select project_id, provider, capabilities
             from runtimes
             where id = $1
             for share",
            &[&runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate requested runtime owner: {error}"
            ))
        })?;
    let Some(row) = row else {
        if super::provider::provider_is_self_hosted(state, requested_provider) {
            return Err(bad_request(
                "self-hosted runtime is not registered by this user",
            ));
        }
        return Ok(false);
    };
    let runtime_project_id: Uuid = row.get("project_id");
    if runtime_project_id != *project_id {
        return Err(forbidden("runtime does not belong to this project"));
    }
    let provider: String = row.get("provider");
    let capabilities: JsonValue = row.get("capabilities");
    super::access::ensure_self_hosted_runtime_access(
        state,
        &provider,
        &capabilities,
        context.user_id,
        context.is_service_role,
    )?;
    Ok(super::access::runtime_is_private_self_hosted(
        state,
        &provider,
        &capabilities,
    ))
}

/// Stable code of a refused tenant attach. A tenant attach answers a runtime
/// that does not exist, a runtime whose project is missing or deleted, and a
/// runtime whose project the caller cannot write to alike, so these tenant
/// refusals cannot be told apart from each other. This covers the tenant
/// scope only: the other scopes answer a `runtimeId` in their own way (see
/// `authorize_explicit_runtime_target`).
const TENANT_RUNTIME_NOT_FOUND_CODE: &str = "runtime_not_found";

fn tenant_runtime_not_found() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::NOT_FOUND,
        Json(ApiError {
            message: "runtime not found".to_string(),
            code: Some(TENANT_RUNTIME_NOT_FOUND_CODE.to_string()),
            details: None,
        }),
    )
}

/// Authorize a tenant attach against the runtime it names.
///
/// A tenant lease attaches the payload project to a runtime that another
/// project, the host, owns and runs. The caller must be able to write to the
/// host project as well as to the tenant project, the rule the tenant manifest
/// on `/projects/:id/runtime/activity` already applies, and the tenant
/// project's organization must be allowed to use the host runtime's provider.
/// A missing runtime, a missing or deleted host project and a host project the
/// caller cannot write to are all refused with [`tenant_runtime_not_found`].
///
/// Returns the host project id. The attach runs in a later transaction, which
/// locks the runtime, requires it to still belong to this project and checks
/// the caller's write access to the project again (see
/// `ensure_runtime_tenant`). A lock taken here would end with this
/// transaction, before the attach, so this read takes none.
async fn authorize_tenant_host_runtime(
    state: &AppState,
    transaction: &Transaction<'_>,
    tenant_project: &crate::ProjectRecord,
    runtime_id: Uuid,
    context: &RequestContext,
) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select project_id, provider
             from runtimes
             where id = $1",
            &[&runtime_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load tenant host runtime: {error}")))?;
    let Some(row) = row else {
        return Err(tenant_runtime_not_found());
    };
    let host_project_id: Uuid = row.get("project_id");
    let provider: String = row.get("provider");

    ensure_tenant_host_write_access(transaction, &host_project_id, context).await?;

    authorize_provider_for_project(state, &provider, tenant_project.org_id)?;
    Ok(host_project_id)
}

/// The caller must be able to write to the host project, the project that
/// owns the runtime a tenant attach names. Anonymous dev-mode requests skip
/// project access checks for the tenant project too (see `runtime_ensure`).
async fn ensure_tenant_host_write_access(
    transaction: &Transaction<'_>,
    host_project_id: &Uuid,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if !context.is_service_role && context.user_id.is_none() {
        return Ok(());
    }
    let host_project = load_project_record(transaction, host_project_id)
        .await
        .map_err(as_tenant_runtime_not_found)?;
    ensure_project_write_access(transaction, &host_project, context, None)
        .await
        .map_err(as_tenant_runtime_not_found)?;
    Ok(())
}

/// A missing runtime or host project, or a refused host project access check,
/// becomes the tenant attach's not-found answer; any other failure (a database
/// error) is reported as is.
fn as_tenant_runtime_not_found(
    (status, body): (StatusCode, Json<ApiError>),
) -> (StatusCode, Json<ApiError>) {
    if matches!(
        status,
        StatusCode::NOT_FOUND | StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED
    ) {
        tenant_runtime_not_found()
    } else {
        (status, body)
    }
}

pub(crate) async fn runtime_ensure(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<RuntimeEnsurePayload>,
) -> Result<Json<RuntimeEnsureResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = Uuid::from_str(&payload.project_id)
        .map_err(|_| bad_request("project_id must be a valid UUID"))?;
    let auth = authenticate_request(&state.config, &headers).await?;
    if !auth.is_service_role && auth.user_id.is_none() && !state.config.dev_mode {
        return Err(unauthorized("runtime ensure requires a user session"));
    }

    if !state.config.dev_mode && !auth.is_service_role {
        if let Some(user_id) = auth.user_id {
            state
                .rate_limiter
                .enforce(
                    format!("runtime:ensure:user:{user_id}"),
                    240,
                    Duration::from_secs(60),
                )
                .await
                .map_err(|limit| {
                    let seconds = limit.retry_after.as_secs().max(1);
                    too_many_requests(format!(
                        "Too many runtime requests. Try again in {seconds}s."
                    ))
                })?;
        }
    }

    let runtime_provider = payload
        .provider
        .as_ref()
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .unwrap_or_else(|| state.provider_registry.default_provider_id());
    let runtime_id = payload
        .runtime_id
        .as_ref()
        .map(|raw| {
            Uuid::from_str(raw.trim()).map_err(|_| bad_request("runtimeId must be a valid UUID"))
        })
        .transpose()?;
    let scope = parse_lease_scope(payload.scope.as_deref())?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Runtime startup", error))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| database_unavailable("Runtime startup", error))?;

    let project = match load_project_record(&transaction, &project_id).await {
        Ok(project) => project,
        Err((status, _))
            if status == StatusCode::NOT_FOUND && state.config.auto_create_projects =>
        {
            ensure_project_exists(&transaction, &project_id, state.config.auto_create_projects)
                .await?;
            load_project_record(&transaction, &project_id).await?
        }
        Err(err) => return Err(err),
    };

    authorize_provider_for_project(&state, &runtime_provider, project.org_id)?;

    if auth.is_service_role || auth.user_id.is_some() {
        ensure_project_write_access(&transaction, &project, &auth, None).await?;
    }

    let tenant_target = if scope == RuntimeLeaseScope::Tenant {
        let runtime_id =
            runtime_id.ok_or_else(|| bad_request("runtimeId is required for tenant leases"))?;
        let host_project_id =
            authorize_tenant_host_runtime(&state, &transaction, &project, runtime_id, &auth)
                .await?;
        Some((runtime_id, host_project_id))
    } else {
        None
    };

    let targets_private_self_hosted_runtime = if scope == RuntimeLeaseScope::Tenant {
        false
    } else {
        authorize_explicit_runtime_target(
            &state,
            &transaction,
            &project_id,
            runtime_id,
            &runtime_provider,
            &auth,
        )
        .await?
    };

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit project lookup: {error}")))?;
    drop(connection);

    let idle_ttl_seconds = coerce_idle_ttl(payload.idle_ttl_seconds);
    let display_name = normalize_display_name_owned(payload.display_name.clone());
    let metadata = payload.metadata.clone();
    let origin_options = OriginEnsureOptions::new(
        payload.origin_mode.clone(),
        payload.origin_protocols.clone(),
        payload.origin_metadata.clone(),
    );

    let wait_source = if auth.user_id.is_some() {
        LimitWaitSource::User
    } else {
        LimitWaitSource::Server
    };
    let response = match scope {
        RuntimeLeaseScope::Exclusive => {
            ensure_runtime_launch_recording_limit_wait(
                &state,
                wait_source,
                project_id,
                runtime_id,
                runtime_provider.clone(),
                idle_ttl_seconds,
                display_name.clone(),
                metadata.clone(),
                RuntimeLeaseScope::Exclusive,
                origin_options.clone(),
                ReusedLeaseMetadata::Requested,
            )
            .await?
        }
        RuntimeLeaseScope::Shared => {
            if super::provider::provider_is_self_hosted(&state, &runtime_provider)
                || targets_private_self_hosted_runtime
            {
                return Err(forbidden(
                    "private self-hosted runtimes cannot use shared leases",
                ));
            }
            ensure_runtime_launch_recording_limit_wait(
                &state,
                wait_source,
                project_id,
                runtime_id,
                runtime_provider.clone(),
                idle_ttl_seconds,
                display_name.clone(),
                metadata.clone(),
                RuntimeLeaseScope::Shared,
                origin_options.clone(),
                ReusedLeaseMetadata::Requested,
            )
            .await?
        }
        RuntimeLeaseScope::Tenant => {
            let (runtime_id, host_project_id) =
                tenant_target.ok_or_else(|| internal_error("tenant attach was not authorized"))?;
            // The origin options are not used: the origin is the host's.
            ensure_runtime_tenant(
                &state,
                project_id,
                runtime_id,
                host_project_id,
                metadata.clone(),
                &auth,
            )
            .await?
        }
    };

    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
pub(super) struct RuntimeRequestPathParams {
    project_id: String,
}

#[derive(Debug, Deserialize, Default)]
pub(super) struct RuntimeRequestBody {
    #[serde(
        default,
        rename = "provider",
        alias = "runtimeType",
        alias = "runtime_type"
    )]
    provider: Option<String>,
    #[serde(default, rename = "displayName", alias = "display_name")]
    display_name: Option<String>,
    #[serde(default, rename = "idleTtlSeconds", alias = "idle_ttl_seconds")]
    idle_ttl_seconds: Option<u32>,
    #[serde(default)]
    metadata: Option<JsonValue>,
    #[serde(default, rename = "originMetadata", alias = "origin_metadata")]
    origin_metadata: Option<JsonValue>,
    #[serde(default, rename = "tunnelMetadata", alias = "tunnel_metadata")]
    tunnel_metadata: Option<JsonValue>,
    #[serde(default, rename = "requestTunnel", alias = "request_tunnel")]
    request_tunnel: Option<bool>,
    #[serde(default, rename = "runtimeId", alias = "runtime_id")]
    runtime_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct RuntimeRequestResponse {
    runtime: RuntimeEnsureResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    tunnel: Option<TunnelGrantResponse>,
}

#[instrument(skip(state, headers, body))]
pub(super) async fn request_runtime(
    State(state): State<AppState>,
    Path(params): Path<RuntimeRequestPathParams>,
    headers: HeaderMap,
    Json(body): Json<RuntimeRequestBody>,
) -> Result<Json<RuntimeRequestResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = Uuid::from_str(&params.project_id)
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let auth = authenticate_request(&state.config, &headers).await?;
    request_runtime_inner(&state, project_id, auth, body).await
}

async fn request_runtime_inner(
    state: &AppState,
    project_id: Uuid,
    auth: RequestContext,
    body: RuntimeRequestBody,
) -> Result<Json<RuntimeRequestResponse>, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Runtime request", error))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| database_unavailable("Runtime request", error))?;

    let project = match load_project_record(&transaction, &project_id).await {
        Ok(project) => project,
        Err((status, _))
            if status == StatusCode::NOT_FOUND && state.config.auto_create_projects =>
        {
            ensure_project_exists(&transaction, &project_id, state.config.auto_create_projects)
                .await?;
            load_project_record(&transaction, &project_id).await?
        }
        Err(err) => return Err(err),
    };
    let runtime_provider = body
        .provider
        .clone()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| state.provider_registry.default_provider_id());
    let runtime_id = parse_optional_uuid_param(body.runtime_id.clone(), "runtimeId")?;
    authorize_provider_for_project(&state, &runtime_provider, project.org_id)?;

    ensure_project_write_access(&transaction, &project, &auth, None).await?;
    authorize_explicit_runtime_target(
        state,
        &transaction,
        &project_id,
        runtime_id,
        &runtime_provider,
        &auth,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit project lookup: {error}")))?;
    drop(connection);
    authorize_provider_for_project(&state, &runtime_provider, project.org_id)?;
    let idle_ttl_seconds = coerce_idle_ttl(body.idle_ttl_seconds);

    let origin_mode = None;

    let origin_options = OriginEnsureOptions::new(origin_mode, None, body.origin_metadata.clone());
    let wait_source = if auth.user_id.is_some() {
        LimitWaitSource::User
    } else {
        LimitWaitSource::Server
    };
    let runtime_response = ensure_runtime_launch_recording_limit_wait(
        state,
        wait_source,
        project_id,
        runtime_id,
        runtime_provider.clone(),
        idle_ttl_seconds,
        body.display_name.clone(),
        body.metadata.clone(),
        RuntimeLeaseScope::Exclusive,
        origin_options,
        ReusedLeaseMetadata::Requested,
    )
    .await?;

    let runtime_uuid = Uuid::from_str(&runtime_response.runtime_id).map_err(|_| {
        internal_error("runtime ensure returned an invalid runtime identifier".to_string())
    })?;
    let lease_uuid = Uuid::from_str(&runtime_response.lease_id).map_err(|_| {
        internal_error("runtime ensure returned an invalid lease identifier".to_string())
    })?;

    let tunnel = if body.request_tunnel.unwrap_or(true) {
        match request_runtime_tunnel(
            state,
            &project_id,
            Some(&runtime_uuid),
            Some(&lease_uuid),
            body.tunnel_metadata.clone(),
        )
        .await
        {
            Ok(grant) => Some(grant),
            Err((status, payload)) => {
                warn!(
                    %project_id,
                    %runtime_uuid,
                    status = ?status,
                    error = %payload.0.message,
                    "runtime tunnel request failed"
                );
                None
            }
        }
    } else {
        None
    };

    Ok(Json(RuntimeRequestResponse {
        runtime: runtime_response,
        tunnel,
    }))
}

pub(super) async fn ensure_runtime_for_requeued_jobs(
    state: &AppState,
    runtime: &RuntimeDetails,
    source: &str,
) -> Result<RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
    let existing_metadata = load_runtime_requeue_metadata(state, runtime).await?;
    let metadata = build_requeued_runtime_metadata(existing_metadata.as_ref(), runtime.id, source);

    ensure_runtime_launch_recording_limit_wait(
        state,
        LimitWaitSource::Server,
        runtime.project_id,
        Some(runtime.id),
        runtime.provider.clone(),
        coerce_idle_ttl(Some(runtime.idle_ttl_seconds.max(0) as u32)),
        runtime.display_name.clone(),
        Some(metadata),
        RuntimeLeaseScope::Exclusive,
        OriginEnsureOptions::new(None, None, None),
        ReusedLeaseMetadata::Requested,
    )
    .await
}

pub(crate) async fn ensure_runtime_for_dispatch_reconnect(
    state: &AppState,
    runtime: &RuntimeRecord,
    source: &str,
    force_new_lease: bool,
) -> Result<RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
    // Read before a forced handoff releases the lease, so the successor
    // launches with the same image and size as the generation it replaces.
    let live_lease = load_live_lease_metadata(state, &runtime.id).await?;
    let carried_from = live_lease.as_ref().map(|(lease_id, _)| *lease_id);
    // With no live lease, as after an idle stop, the newest lease still says
    // which image the runtime was launched with. The reconnect still passes
    // `CarriedFrom(None)`, so a lease another start creates meanwhile keeps
    // its own settings and is never refused over a flavor read from this one.
    let ended_lease = match live_lease {
        Some(_) => None,
        None => load_newest_lease_metadata(state, runtime).await?,
    };
    let metadata = build_dispatch_reconnect_metadata(
        &runtime.provider,
        live_lease
            .as_ref()
            .map(|(lease_id, metadata)| (*lease_id, metadata.as_ref())),
        ended_lease
            .as_ref()
            .map(|(lease_id, metadata)| (*lease_id, metadata.as_ref())),
        runtime.id,
        source,
        force_new_lease,
    );

    if force_new_lease && runtime.active_lease_id.is_some() {
        // A dispatch reconnect is a real generation handoff. The old provider
        // allocation must acknowledge release before its active lease can be
        // cleared or a successor lease can be launched.
        stop_runtime_for_project(
            state,
            &runtime.project_id,
            &runtime.id,
            Some(format!("dispatch_reconnect:{source}")),
            "dispatch_reconnect",
        )
        .await?;
    }

    ensure_runtime_launch_recording_limit_wait(
        state,
        LimitWaitSource::Server,
        runtime.project_id,
        Some(runtime.id),
        runtime.provider.clone(),
        coerce_idle_ttl(Some(runtime.idle_ttl_seconds.max(0) as u32)),
        runtime.display_name.clone(),
        Some(metadata),
        RuntimeLeaseScope::Exclusive,
        OriginEnsureOptions::new(None, None, None),
        ReusedLeaseMetadata::CarriedFrom(carried_from),
    )
    .await
}

/// The runtime's unreleased active lease and the metadata it holds.
async fn load_live_lease_metadata(
    state: &AppState,
    runtime_id: &Uuid,
) -> Result<Option<(Uuid, Option<JsonValue>)>, (StatusCode, Json<ApiError>)> {
    let conn = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Runtime lease", error))?;
    let row = conn
        .query_opt(
            "select rl.id, rl.metadata
             from runtimes r
             join runtime_leases rl on rl.id = r.active_lease_id
             where r.id = $1
               and rl.released_at is null",
            &[runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load live runtime lease metadata: {error}"
            ))
        })?;
    Ok(row.map(|row| (row.get("id"), row.get("metadata"))))
}

/// The runtime's newest own launch generation and the metadata it holds,
/// newest by request time.
///
/// Only leases the launch path wrote for the runtime's own project count. A
/// tenant lease carries the host runtime's id but another project's, and its
/// metadata is stored as the attaching caller sent it, so an attestation in
/// it proves nothing about how the controller launched this runtime.
async fn load_newest_lease_metadata(
    state: &AppState,
    runtime: &RuntimeRecord,
) -> Result<Option<(Uuid, Option<JsonValue>)>, (StatusCode, Json<ApiError>)> {
    let conn = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Runtime lease", error))?;
    let row = conn
        .query_opt(
            "select id, metadata
             from runtime_leases
             where runtime_id = $1
               and project_id = $2
               and scope <> 'tenant'
               and parent_lease_id is null
             order by requested_at desc
             limit 1",
            &[&runtime.id, &runtime.project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load newest runtime lease metadata: {error}"
            ))
        })?;
    Ok(row.map(|row| (row.get("id"), row.get("metadata"))))
}

/// The metadata a dispatch reconnect ensures its runtime with.
///
/// Reuse compares the requested managed flavor with the one the live lease
/// launched with and refuses a mismatch ("managed runtime flavor does not
/// match the active lease"), so a reconnect that named no flavor failed with
/// a 409 against every live webdev runtime. A reused lease also takes the
/// request's metadata as its own, which billing (`sizeId`) and a later
/// requeue read back, so a bare reconnect reset a boosted runtime to the
/// standard size. The reconnect therefore carries the live lease's metadata
/// forward, as the requeue path does. The flavor is taken from the lease's
/// launch attestation rather than its stored field, because the attestation
/// is what reuse compares against.
///
/// `ended_lease` is the runtime's newest lease, read only when no lease is
/// live; see [`ended_lease_launch_settings`] for the little it carries.
fn build_dispatch_reconnect_metadata(
    provider: &str,
    live_lease: Option<(Uuid, Option<&JsonValue>)>,
    ended_lease: Option<(Uuid, Option<&JsonValue>)>,
    runtime_id: Uuid,
    source: &str,
    force_new_lease: bool,
) -> JsonValue {
    let mut metadata = match live_lease {
        Some((lease_id, lease_metadata)) => {
            let mut metadata = match lease_metadata {
                Some(JsonValue::Object(existing)) => existing.clone(),
                _ => serde_json::Map::new(),
            };
            // An attestation binds one lease generation, and the launch path
            // writes its own for the lease it reuses or creates.
            metadata.remove(super::managed::MANAGED_RUNTIME_LAUNCH_ATTESTATION);
            metadata.remove(super::managed::MANAGED_RUNTIME_FLAVOR_KEY);
            if super::managed::managed_webdev_launch_is_attested(provider, lease_metadata, lease_id)
            {
                metadata.insert(
                    super::managed::MANAGED_RUNTIME_FLAVOR_KEY.to_string(),
                    JsonValue::String(super::managed::MANAGED_RUNTIME_WEBDEV_FLAVOR.to_string()),
                );
            }
            metadata
        }
        None => ended_lease
            .map(|(lease_id, lease_metadata)| {
                ended_lease_launch_settings(provider, lease_id, lease_metadata)
            })
            .unwrap_or_default(),
    };
    metadata.insert("source".to_string(), JsonValue::String(source.to_string()));
    metadata.insert("runtimeId".to_string(), json!(runtime_id));
    metadata.insert(
        "forceNewLease".to_string(),
        JsonValue::Bool(force_new_lease),
    );
    JsonValue::Object(metadata)
}

/// What a dispatch reconnect keeps of a runtime with no live lease, such as
/// one stopped for idling: the image it launched with and its Shared Browser
/// settings, and nothing that changes its bill.
///
/// A webdev runtime is named and chosen as the webdev runtime, and the Shared
/// Browser needs the webdev image, so relaunching it with the base image left
/// a runtime that looked right and could not do its job. When the newest
/// lease's own launch attestation proves a webdev launch, the reconnect asks
/// for the webdev flavor again, plus that lease's browser settings: the
/// browser session switch, without which the image starts no browser, and the
/// viewer preferences the Studio asked for, so the Shared Browser comes back
/// with the same viewer. Only env keys a client may request itself
/// (`allowed_managed_runtime_request_env_key`) are carried, and they pass the
/// same request boundary again; resource limits and TURN credentials are
/// injected fresh after it. A stored `runtimeFlavor` without that attestation
/// is only what someone asked for, not what the controller launched, and
/// carries nothing.
///
/// `sizeId` stays behind. It is what billing reads, and with no live lease
/// there is no running machine whose size the reconnect has to keep, so the
/// runtime starts at the standard size; a Boost has to be asked for again.
fn ended_lease_launch_settings(
    provider: &str,
    lease_id: Uuid,
    lease_metadata: Option<&JsonValue>,
) -> serde_json::Map<String, JsonValue> {
    let mut settings = serde_json::Map::new();
    if !super::managed::managed_webdev_launch_is_attested(provider, lease_metadata, lease_id) {
        return settings;
    }
    settings.insert(
        super::managed::MANAGED_RUNTIME_FLAVOR_KEY.to_string(),
        JsonValue::String(super::managed::MANAGED_RUNTIME_WEBDEV_FLAVOR.to_string()),
    );
    let browser_env: serde_json::Map<String, JsonValue> = lease_metadata
        .and_then(|metadata| metadata.get("env"))
        .and_then(JsonValue::as_object)
        .into_iter()
        .flatten()
        .filter(|(key, _)| super::managed::allowed_managed_runtime_request_env_key(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if !browser_env.is_empty() {
        settings.insert("env".to_string(), JsonValue::Object(browser_env));
    }
    settings
}

async fn load_runtime_requeue_metadata(
    state: &AppState,
    runtime: &RuntimeDetails,
) -> Result<Option<JsonValue>, (StatusCode, Json<ApiError>)> {
    let conn = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Runtime lease", error))?;

    if let Some(active_lease_id) = runtime.active_lease_id {
        if let Some(row) = conn
            .query_opt(
                "select metadata from runtime_leases where id = $1",
                &[&active_lease_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to load active runtime lease metadata: {error}"
                ))
            })?
        {
            let metadata: Option<JsonValue> = row.get("metadata");
            if metadata.is_some() {
                return Ok(metadata);
            }
        }
    }

    // Otherwise the runtime's newest own launch generation. A tenant lease
    // carries this runtime's id, but it launched nothing and its metadata is
    // what the attaching caller sent (see `load_newest_lease_metadata`).
    let row = conn
        .query_opt(
            "select metadata
             from runtime_leases
             where runtime_id = $1
               and project_id = $2
               and scope <> 'tenant'
               and parent_lease_id is null
             order by requested_at desc
             limit 1",
            &[&runtime.id, &runtime.project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load fallback runtime lease metadata: {error}"
            ))
        })?;
    Ok(row.and_then(|record| record.get::<_, Option<JsonValue>>("metadata")))
}

fn build_requeued_runtime_metadata(
    existing: Option<&JsonValue>,
    runtime_id: Uuid,
    source: &str,
) -> JsonValue {
    let mut metadata = match existing.cloned() {
        Some(JsonValue::Object(existing)) => existing,
        Some(other) => {
            let mut map = serde_json::Map::new();
            map.insert("previous_metadata".to_string(), other);
            map
        }
        None => serde_json::Map::new(),
    };

    metadata.insert("source".to_string(), JsonValue::String(source.to_string()));
    metadata.insert(
        "reason".to_string(),
        JsonValue::String("queued_jobs_after_runtime_stop".to_string()),
    );
    metadata.insert(
        "runtime_id".to_string(),
        JsonValue::String(runtime_id.to_string()),
    );
    JsonValue::Object(metadata)
}

pub(crate) async fn ensure_runtime_for_automation(
    state: &AppState,
    project_id: Uuid,
    provider: Option<String>,
    runtime_id: Option<Uuid>,
    idle_ttl_seconds: Option<u32>,
    display_name: Option<String>,
    metadata: Option<JsonValue>,
) -> Result<RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
    let provider = provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| state.provider_registry.default_provider_id());

    ensure_runtime_launch_recording_limit_wait(
        state,
        LimitWaitSource::Server,
        project_id,
        runtime_id,
        provider,
        coerce_idle_ttl(idle_ttl_seconds),
        display_name,
        metadata,
        RuntimeLeaseScope::Exclusive,
        OriginEnsureOptions::new(None, None, None),
        ReusedLeaseMetadata::Requested,
    )
    .await
}

/// Resolves the requested machine size and rewrites the metadata so the
/// resource-limit envs are always server-derived: the client picks a size id,
/// never raw RUNTIME_CPU_LIMIT/RUNTIME_MEMORY_LIMIT values (those would be
/// free compute — the provider forwards metadata.env into docker compose).
fn normalize_runtime_size_metadata(
    metadata: Option<JsonValue>,
) -> (
    Option<JsonValue>,
    &'static crate::runtime::sizes::RuntimeSize,
) {
    use serde_json::Map as JsonMap;

    let size = crate::runtime::sizes::size_from_metadata(&metadata);
    let mut map = match metadata {
        Some(JsonValue::Object(map)) => map,
        Some(other) => {
            let mut map = JsonMap::new();
            map.insert("runtimeMetadata".to_string(), other);
            map
        }
        None => JsonMap::new(),
    };
    map.insert("sizeId".to_string(), JsonValue::String(size.id.to_string()));

    let mut env = match map.remove("env") {
        Some(JsonValue::Object(env)) => env,
        _ => JsonMap::new(),
    };
    env.insert(
        "RUNTIME_CPU_LIMIT".to_string(),
        JsonValue::String(size.cpus.to_string()),
    );
    env.insert(
        "RUNTIME_MEMORY_LIMIT".to_string(),
        JsonValue::String(size.memory.to_string()),
    );
    map.insert("env".to_string(), JsonValue::Object(env));

    (Some(JsonValue::Object(map)), size)
}

/// Which metadata a live lease keeps when an ensure reuses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ReusedLeaseMetadata {
    /// The request's own metadata, once its flavor matches the lease's
    /// launch. A caller that names settings gets them on the reused lease.
    Requested,
    /// The request carries forward the settings of this lease generation
    /// (`None`: there was no live lease), read before the allocation
    /// transaction. Only that same lease takes them on reuse.
    CarriedFrom(Option<Uuid>),
}

impl ReusedLeaseMetadata {
    /// Whether reusing `lease_id` writes the request's metadata onto it.
    ///
    /// Carried settings are read outside the allocation transaction, so a
    /// concurrent ensure can replace the lease they came from before this one
    /// reuses the runtime. Written onto that other generation, one lease's
    /// size and env would bill and relaunch another as the wrong machine, and
    /// a flavor copied from it would refuse a live runtime that is fine as it
    /// is. Any other lease therefore keeps its own metadata.
    fn applies_to_reused_lease(self, lease_id: Uuid) -> bool {
        match self {
            Self::Requested => true,
            Self::CarriedFrom(source) => source == Some(lease_id),
        }
    }
}

/// [`ensure_runtime_launch`] for a request that must not be forgotten when the
/// organization's hosted runtime limit refuses it: the refusal is recorded so
/// the limit-wait sweep can replay this exact request once work is queued in
/// the space and a slot may be free (see `limit_waits.rs`).
#[allow(clippy::too_many_arguments)]
pub(super) async fn ensure_runtime_launch_recording_limit_wait(
    state: &AppState,
    wait_source: LimitWaitSource,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    provider: String,
    idle_ttl_seconds: u32,
    display_name: Option<String>,
    metadata: Option<JsonValue>,
    scope: RuntimeLeaseScope,
    origin_options: OriginEnsureOptions,
    reused_lease_metadata: ReusedLeaseMetadata,
) -> Result<RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
    let wait_request = LimitWaitEnsureRequest {
        provider: provider.clone(),
        runtime_id,
        idle_ttl_seconds,
        display_name: display_name.clone(),
        metadata: metadata.clone(),
        scope: Some(scope.as_str().to_string()),
        origin_mode: origin_options.mode.clone(),
        origin_protocols: origin_options.protocols.clone(),
    };
    let result = ensure_runtime_launch(
        state,
        project_id,
        runtime_id,
        provider,
        idle_ttl_seconds,
        display_name,
        metadata,
        scope,
        origin_options,
        reused_lease_metadata,
    )
    .await;
    if let Err(error) = &result {
        if is_runtime_limit_refusal(error) {
            record_hosted_runtime_limit_refusal(state, project_id, &wait_request, wait_source)
                .await;
        }
    }
    result
}

/// Replay a recorded refused ensure for the limit-wait sweep. Deliberately the
/// ordinary launch path: the organization limit, the credit precheck and the
/// idle-slot reclaim decide exactly as they would for the user's own request.
/// Not recorded again; the sweep keeps its own bookkeeping.
pub(super) async fn ensure_runtime_for_limit_wait(
    state: &AppState,
    project_id: Uuid,
    request: &LimitWaitEnsureRequest,
) -> Result<RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
    ensure_runtime_launch(
        state,
        project_id,
        request.runtime_id,
        request.provider.clone(),
        coerce_idle_ttl(Some(request.idle_ttl_seconds)),
        request.display_name.clone(),
        request.metadata.clone(),
        request.lease_scope(),
        OriginEnsureOptions::new(
            request.origin_mode.clone(),
            Some(request.origin_protocols.clone()),
            None,
        ),
        ReusedLeaseMetadata::Requested,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn ensure_runtime_launch(
    state: &AppState,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    provider: String,
    idle_ttl_seconds: u32,
    display_name: Option<String>,
    metadata: Option<JsonValue>,
    scope: RuntimeLeaseScope,
    origin_options: OriginEnsureOptions,
    reused_lease_metadata: ReusedLeaseMetadata,
) -> Result<RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
    #[cfg(test)]
    {
        return ensure_runtime_launch_inner(
            state,
            project_id,
            runtime_id,
            provider,
            idle_ttl_seconds,
            display_name,
            metadata,
            scope,
            origin_options,
            reused_lease_metadata,
            None,
        )
        .await;
    }

    #[cfg(not(test))]
    ensure_runtime_launch_inner(
        state,
        project_id,
        runtime_id,
        provider,
        idle_ttl_seconds,
        display_name,
        metadata,
        scope,
        origin_options,
        reused_lease_metadata,
    )
    .await
}

/// Release a stale active generation before `ensure_runtime_record` resets the
/// runtime's launch-facing fields. This probe intentionally runs outside the
/// allocation transaction: provider acknowledgement can take network time and
/// must not retain a database connection or let a successor lease overtake it.
async fn cleanup_stale_runtime_generation_before_ensure(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: Option<Uuid>,
    provider: &str,
    display_name: Option<&str>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Runtime stale-generation probe", error))?;

    let row = if let Some(runtime_id) = runtime_id {
        connection
            .query_opt(
                "select r.id, r.provider, r.status, r.idle_ttl_seconds, r.last_seen_at,
                        r.endpoint_url, r.active_lease_id,
                        lease.status as active_lease_status
                 from runtimes r
                 left join runtime_leases lease on lease.id = r.active_lease_id
                 where r.project_id = $1 and r.id = $2",
                &[project_id, &runtime_id],
            )
            .await
    } else {
        connection
            .query_opt(
                "select r.id, r.provider, r.status, r.idle_ttl_seconds, r.last_seen_at,
                        r.endpoint_url, r.active_lease_id,
                        lease.status as active_lease_status
                 from runtimes r
                 left join runtime_leases lease on lease.id = r.active_lease_id
                 where r.project_id = $1
                   and r.provider = $2
                   and ($3::text is null or r.display_name = $3)
                 order by
                   case
                     when r.status in ('ready', 'running') then 0
                     when r.status = 'requested' then 1
                     else 2
                   end,
                   r.updated_at desc
                 limit 1",
                &[project_id, &provider, &display_name],
            )
            .await
    }
    .map_err(|error| {
        internal_error(format!(
            "failed to probe stale runtime generation before ensure: {error}"
        ))
    })?;

    let Some(row) = row else {
        return Ok(());
    };
    let stored_provider: String = row.get("provider");
    if !runtime_provider_identity_matches(&stored_provider, provider) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "runtime provider identity does not match the requested provider",
            )),
        ));
    }
    let active_lease_id: Option<Uuid> = row.get("active_lease_id");
    if active_lease_id.is_none() {
        return Ok(());
    }

    let candidate_runtime_id: Uuid = row.get("id");
    let status: String = row.get("status");
    let idle_ttl_seconds: i32 = row.get("idle_ttl_seconds");
    let last_seen_at: Option<chrono::DateTime<Utc>> = row.get("last_seen_at");
    let endpoint_url: Option<String> = row.get("endpoint_url");
    let active_lease_status: Option<String> = row.get("active_lease_status");
    let cleanup_pending = active_lease_status.as_deref() == Some("cleanup_pending");
    let terminal = matches!(status.as_str(), "offline" | "stopped" | "removed");
    let stale = !crate::workspace::runtime_is_recent(
        last_seen_at,
        idle_ttl_seconds,
        crate::workspace::endpoint_matches_local(endpoint_url.as_deref()),
    );

    // A normal requested/launching generation has not emitted its first
    // heartbeat yet. Reuse it; only retry requested state when a previous stop
    // has already quarantined it for provider cleanup.
    if !cleanup_pending && !terminal && (status == "requested" || !stale) {
        return Ok(());
    }
    drop(connection);

    let stopped = stop_runtime_safely(
        state,
        &candidate_runtime_id,
        StopOptions {
            source: "ensure_stale_generation",
            reason: Some("stale_generation_before_ensure".to_string()),
            // For a merely stale heartbeat, a live job or a concurrently
            // refreshed heartbeat wins. Terminal and cleanup-pending states
            // are already unavailable and must complete cleanup.
            skip_if_active_jobs: !terminal && !cleanup_pending,
            require_idle_timeout: !terminal && !cleanup_pending,
            allow_cleanup_pending_release: false,
            expected_identity: None,
        },
    )
    .await?;

    if let Some(skip_reason) = stopped.outcome.skip_reason.as_deref() {
        info!(
            runtime_id = %candidate_runtime_id,
            %skip_reason,
            "stale runtime generation cleanup lost a revalidation race; reusing current state"
        );
    }
    Ok(())
}

async fn ensure_runtime_launch_inner(
    state: &AppState,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    provider: String,
    idle_ttl_seconds: u32,
    display_name: Option<String>,
    metadata: Option<JsonValue>,
    scope: RuntimeLeaseScope,
    origin_options: OriginEnsureOptions,
    reused_lease_metadata: ReusedLeaseMetadata,
    #[cfg(test)] admission_test_hook: Option<ProviderLaunchAdmissionTestHook>,
) -> Result<RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
    if super::provider::provider_is_self_hosted(state, &provider) && runtime_id.is_none() {
        return Err(bad_request(
            "self-hosted runtime launch requires an explicit owner-bound runtimeId",
        ));
    }
    cleanup_stale_runtime_generation_before_ensure(
        state,
        &project_id,
        runtime_id,
        &provider,
        display_name.as_deref(),
    )
    .await?;

    // Existing runtime/lease reuse stays on a short database-only fast path. A
    // request that actually needs provider work rolls that probe back, enters
    // the launch admission queue outside the pool, and only then repeats the
    // allocation transaction. Crucially, every pass resolves a fresh provider
    // snapshot. After an admission wait, authorization, provider kind, routing,
    // credentials, metadata, billing, and the eventual HTTP call therefore all
    // use one coherent current registry generation.
    let mut provider_launch_admission = None;

    let metadata = super::managed::sanitize_managed_runtime_request_metadata(&provider, metadata)
        .map_err(bad_request)?;
    let (metadata, runtime_size) = normalize_runtime_size_metadata(metadata);
    // One reclaim per request. The retry re-runs the whole allocation, and a
    // second refusal means the slot was taken by someone else; looping on it
    // would stop one machine after another on a single prompt.
    let mut hosted_slot_reclaim_attempted = false;
    let (runtime, lease, origin_info, origin_instance_id, provider_cfg, launch_metadata) = 'allocation: loop {
        let provider_cfg = if crate::provider_identifiers::is_self_hosted_provider_id(&provider) {
            None
        } else {
            Some(
                state
                    .provider_registry
                    .provider_config(&provider)
                    .ok_or_else(|| {
                        bad_request(&format!(
                            "provider '{}' is not configured on this controller",
                            provider
                        ))
                    })?,
            )
        };
        let mut conn = state
            .pool
            .get()
            .await
            .map_err(|error| database_unavailable("Runtime lease", error))?;
        let transaction = conn
            .transaction()
            .await
            .map_err(|error| database_unavailable("Runtime lease", error))?;

        let provider_cfg = match provider_cfg {
            Some(provider_cfg) => {
                lock_and_load_authoritative_provider_config(
                    &transaction,
                    &provider,
                    Some(&provider_cfg),
                )
                .await?
            }
            None => None,
        };
        let provider_requires_external_launch = provider_cfg.as_ref().is_some_and(|config| {
            !crate::provider_identifiers::is_self_hosted_provider_kind(&config.kind)
        });

        ensure_project_exists(&transaction, &project_id, state.config.auto_create_projects).await?;
        let project = load_project_record(&transaction, &project_id).await?;
        let project = ensure_project_org(&transaction, &project).await?;
        if let Some(provider_cfg) = provider_cfg.as_ref() {
            authorize_provider_config_for_project(provider_cfg, project.org_id)?;
        }

        let runtime = ensure_runtime_record(
            &transaction,
            &project_id,
            runtime_id,
            &provider,
            idle_ttl_seconds,
            display_name.as_deref(),
            metadata.clone(),
            true,
        )
        .await?;

        let mut reusable_lease: Option<RuntimeLeaseDetails> = None;
        if let Some(active_lease_id) = runtime.active_lease_id {
            let existing = fetch_runtime_lease_for_update(&transaction, &active_lease_id).await?;
            if existing.released_at.is_none() && existing.status == "cleanup_pending" {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::new(
                        "runtime cleanup is still pending; retry after the provider release completes",
                    )),
                ));
            }
            if !lease_is_reusable(&existing) {
                mark_runtime_lease_released(&transaction, &runtime.id, &existing.id, false).await?;
            } else {
                match (scope, existing.scope) {
                    (RuntimeLeaseScope::Shared, RuntimeLeaseScope::Shared) => {
                        reusable_lease = Some(existing);
                    }
                    (RuntimeLeaseScope::Exclusive, RuntimeLeaseScope::Exclusive) => {
                        let lease_status = existing.status.as_str();
                        if runtime.status == "ready"
                            || runtime.status == "leased"
                            || lease_status == "launching"
                            || lease_status == "active"
                        {
                            reusable_lease = Some(existing);
                        }
                    }
                    (RuntimeLeaseScope::Exclusive, RuntimeLeaseScope::Shared) => {
                        return Err(bad_request(
                            "runtime is locked to a shared lease; release it before requesting exclusive access",
                        ));
                    }
                    (RuntimeLeaseScope::Shared, RuntimeLeaseScope::Exclusive) => {
                        return Err(bad_request(
                            "runtime currently has an exclusive lease; stop it before marking shared",
                        ));
                    }
                    (RuntimeLeaseScope::Tenant, _) => {
                        return Err(bad_request(
                            "tenant scope requires referencing an existing shared runtime",
                        ));
                    }
                    (_, RuntimeLeaseScope::Tenant) => {
                        return Err(bad_request(
                            "runtime active lease is a tenant assignment and cannot be reused",
                        ));
                    }
                }
            }
        }

        if let Some(existing) = reusable_lease {
            if reused_lease_metadata.applies_to_reused_lease(existing.id) {
                let reusable_metadata = super::managed::reconcile_reused_managed_runtime_metadata(
                    &provider,
                    metadata.clone(),
                    existing.metadata.as_ref(),
                    existing.id,
                )
                .map_err(|message| (StatusCode::CONFLICT, Json(ApiError::new(message))))?;
                if let Some(meta) = reusable_metadata.as_ref() {
                    transaction
                        .execute(
                            "update runtime_leases set metadata = $2::jsonb, updated_at = now() where id = $1",
                            &[&existing.id, meta],
                        )
                        .await
                        .map_err(|error| {
                            internal_error(format!(
                                "failed to update reusable lease metadata: {error}"
                            ))
                        })?;
                }
            }

            let origin_instance = upsert_origin_instance(
                &transaction,
                &project_id,
                &runtime.id,
                &existing.id,
                origin_options.mode.clone(),
                origin_options.protocols.clone(),
                origin_options.metadata.clone(),
            )
            .await?;

            ensure_project_available_for_runtime_launch(&transaction, &project_id).await?;

            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to commit runtime reuse: {error}"))
            })?;

            let origin_info = Some(origin_info_from_record(&origin_instance));

            return Ok(RuntimeEnsureResponse {
                runtime_id: runtime.id.to_string(),
                status: runtime.status,
                provider: runtime.provider.clone(),
                lease_id: existing.id.to_string(),
                parent_lease_id: existing.parent_lease_id.map(|value| value.to_string()),
                scope: Some(existing.scope.as_str().to_string()),
                origin: origin_info,
            });
        }

        if provider_requires_external_launch && provider_launch_admission.is_none() {
            transaction.rollback().await.map_err(|error| {
                internal_error(format!(
                    "failed to roll back runtime provider admission probe: {error}"
                ))
            })?;
            drop(conn);
            #[cfg(test)]
            if let Some(hook) = admission_test_hook.as_ref() {
                hook.reached.notify_one();
                hook.proceed.notified().await;
                hook.waiting.notify_one();
            }
            provider_launch_admission = Some(
                RUNTIME_PROVIDER_ENSURE_FENCE_CAPACITY
                    .acquire()
                    .await
                    .map_err(|_| internal_error("runtime provider launch fence is unavailable"))?,
            );
            continue 'allocation;
        }

        if provider_requires_external_launch
            && provider_cfg
                .as_ref()
                .and_then(|config| config.endpoint.as_deref())
                .map(str::trim)
                .is_none_or(str::is_empty)
        {
            let provider_id = provider_cfg
                .as_ref()
                .map(|config| config.id.as_str())
                .unwrap_or(provider.as_str());
            warn!(
                %project_id,
                provider = %provider,
                provider_id,
                "runtime provider endpoint not configured; cannot ensure runtime"
            );
            return Err(internal_error(format!(
                "provider '{provider_id}' is missing an endpoint on this controller"
            )));
        }

        if crate::provider_identifiers::is_instafy_cloud_provider_id(&provider)
            && !state.config.dev_mode
        {
            // Platform-wide capacity gate. Hosted runtimes are containers on the
            // controller box, so an open-signup surge can exhaust the host
            // regardless of per-org limits. Checked first, and only when a cap
            // is configured (0 disables). A count failure fails OPEN — a
            // transient DB hiccup must not lock every user out — because the
            // per-org cap below still applies.
            let global_cap = state.config.max_active_hosted_runtimes_global;
            if global_cap > 0 {
                let global_active_count: i64 = match transaction
                    .query_one(
                        "select count(*)::bigint as active_count
                         from runtimes r
                         join runtime_leases rl on rl.id = r.active_lease_id
                         where (
                             r.provider = 'instafy_cloud'
                             or r.provider like 'instafy\\_cloud\\_%'
                             or r.provider = 'instafy-cloud'
                             or r.provider like 'instafy-cloud-%'
                           )
                           and r.active_lease_id is not null
                           and r.status not in ('stopped', 'removed')
                           and rl.released_at is null
                           and rl.status <> 'failed'",
                        &[],
                    )
                    .await
                {
                    Ok(row) => row.get("active_count"),
                    Err(error) => {
                        warn!(
                            error = ?error,
                            "failed to count active hosted runtimes globally; skipping platform cap"
                        );
                        -1
                    }
                };

                if platform_at_capacity(global_active_count, global_cap) {
                    warn!(
                        global_active_count,
                        global_cap,
                        project_id = %project_id,
                        "refusing hosted runtime allocation: platform at capacity"
                    );
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(ApiError::with_details(
                            "Instafy is at capacity right now — too many cloud runtimes are running. Please try again in a few minutes.",
                            "platform_at_capacity",
                            json!({
                                "activeCount": global_active_count,
                                "maxActiveCount": global_cap,
                            }),
                        )),
                    ));
                }
            }

            let org_id = project
                .org_id
                .ok_or_else(|| internal_error("project missing organization"))?;

            // The count below and the lease insert after it must be one
            // decision per organization. Row locks cannot give that (the
            // competing launch is another space's new row), so two replicas
            // launching for two spaces at once, which the limit-wait sweep
            // makes routine, would both see a free slot. The lock is
            // transaction-scoped: it ends at the commit below, or at the
            // rollback before a reclaim's provider stop, so it only ever
            // covers database work.
            lock_hosted_runtime_admission(&transaction, &org_id).await?;

            let limits = org_limits::resolve_org_resource_limits(&transaction, &org_id).await?;
            let max_active_hosted_runtimes = limits.max_active_hosted_runtimes;

            let active_count: i64 = match transaction
                .query_one(
                    "select count(*)::bigint as active_count
                     from runtimes r
                     join projects p on p.id = r.project_id
                     join runtime_leases rl on rl.id = r.active_lease_id
                     where p.org_id = $1
                       and (
                         r.provider = 'instafy_cloud'
                         or r.provider like 'instafy\\_cloud\\_%'
                         or r.provider = 'instafy-cloud'
                         or r.provider like 'instafy-cloud-%'
                       )
                       and r.active_lease_id is not null
                       and r.status not in ('stopped', 'removed')
                       and rl.released_at is null
                       and rl.status <> 'failed'",
                    &[&org_id],
                )
                .await
            {
                Ok(row) => row.get("active_count"),
                Err(error) => {
                    warn!(
                        org_id = %org_id,
                        error = ?error,
                        "failed to count active hosted runtimes; skipping org runtime limits"
                    );
                    0
                }
            };

            if active_count >= max_active_hosted_runtimes {
                let blocker =
                    match load_active_hosted_runtime_blocker(&transaction, &org_id, &project_id)
                        .await
                    {
                        Ok(value) => value,
                        Err(error) => {
                            warn!(
                                org_id = %org_id,
                                project_id = %project_id,
                                error = ?error,
                                "failed to load hosted runtime blocker details"
                            );
                            None
                        }
                    };

                // The organization's slot may be held by a machine nobody is
                // using: a space the person finished with minutes ago. Take it
                // over for them instead of making them find and stop it by
                // hand. A blocker with any sign of life is left alone and the
                // refusal below still explains where it is.
                let reclaim_idle_seconds = state.config.runtime_limit_reclaim_idle_seconds;
                if let Some(candidate) = blocker.clone() {
                    if reclaim_idle_seconds > 0
                        && !hosted_slot_reclaim_attempted
                        // Never the caller's own machine: reuse above already
                        // decided it was unusable, so stopping it here would
                        // take away the very runtime this request is booting.
                        && candidate.project_id != project_id
                        && hosted_runtime_blocker_is_reclaimable(
                            &transaction,
                            &candidate.runtime_id,
                            reclaim_idle_seconds,
                        )
                        .await
                    {
                        hosted_slot_reclaim_attempted = true;
                        // The stop needs its own connection and then waits on
                        // the provider over the network, so this transaction
                        // has to go first — the same rule the stale-generation
                        // cleanup follows before this loop.
                        transaction.rollback().await.map_err(|error| {
                            internal_error(format!(
                                "failed to roll back before reclaiming a hosted runtime slot: {error}"
                            ))
                        })?;
                        drop(conn);

                        if reclaim_idle_hosted_runtime_blocker(state, &candidate).await {
                            continue 'allocation;
                        }
                        return Err(hosted_runtime_limit_refusal(
                            active_count,
                            max_active_hosted_runtimes,
                            Some(&candidate),
                        ));
                    }
                }

                return Err(hosted_runtime_limit_refusal(
                    active_count,
                    max_active_hosted_runtimes,
                    blocker.as_ref(),
                ));
            }

            // Credit precheck: never launch a runtime the first billing sweep
            // would kill ~60 seconds later — that reads as an unexplained
            // crash. Refuse up front with the actual reason instead.
            let base_burn_amount = provider_cfg
                .as_ref()
                .map(|provider_cfg| {
                    crate::credits::resolve_hosted_runtime_credit_burn_config_for_provider(
                        state,
                        provider_cfg,
                    )
                    .0
                })
                .unwrap_or_else(|| state.config.hosted_runtime_credit_burn_amount.max(0));
            let burn_amount =
                crate::runtime::sizes::scaled_burn_amount(base_burn_amount, runtime_size);
            if burn_amount > 0 {
                let affordability = crate::credits::check_hosted_runtime_affordability(
                    &transaction,
                    &org_id,
                    burn_amount,
                )
                .await?;
                if !affordability.affordable {
                    info!(
                        org_id = %org_id,
                        project_id = %project_id,
                        balance = affordability.balance,
                        burn_amount,
                        "refusing hosted runtime allocation: insufficient credits"
                    );
                    return Err((
                        StatusCode::PAYMENT_REQUIRED,
                        Json(ApiError::with_details(
                            "This team is out of credits for today, so a hosted machine can't start. Credits refill daily at 00:00 UTC — or upgrade the plan, or connect your own machine (free, no limits).",
                            "insufficient_credits",
                            json!({
                                "balance": affordability.balance,
                                "creditLimit": affordability.credit_limit,
                                "requiredCredits": burn_amount,
                            }),
                        )),
                    ));
                }
            }
        }

        let lease = create_runtime_lease(
            &transaction,
            &project_id,
            &runtime.id,
            scope,
            None,
            metadata.clone(),
            true,
        )
        .await?;

        let launch_metadata = super::managed::attest_new_managed_runtime_launch(
            &provider,
            metadata.clone(),
            lease.id,
        );
        transaction
            .execute(
                "update runtime_leases set metadata = $2::jsonb, updated_at = now() where id = $1",
                &[&lease.id, &launch_metadata],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to bind managed runtime launch metadata to lease generation: {error}"
                ))
            })?;

        mark_runtime_lease_launching(&transaction, &lease.id).await?;

        let origin_instance = upsert_origin_instance(
            &transaction,
            &project_id,
            &runtime.id,
            &lease.id,
            origin_options.mode.clone(),
            origin_options.protocols.clone(),
            origin_options.metadata.clone(),
        )
        .await?;

        ensure_project_available_for_runtime_launch(&transaction, &project_id).await?;

        // A commit error does not prove the commit failed: the server can
        // commit and the reply still be lost. The lease may then be the
        // runtime's live generation, so the error names it like any later
        // launch failure, or a caller would take it for another start.
        transaction.commit().await.map_err(|error| {
            with_committed_lease_id(
                internal_error(format!("failed to commit runtime-ensure: {error}")),
                lease.id,
            )
        })?;

        break 'allocation Ok::<_, (StatusCode, Json<ApiError>)>((
            runtime,
            lease,
            Some(origin_info_from_record(&origin_instance)),
            Some(origin_instance.id),
            provider_cfg,
            launch_metadata,
        ));
    }?;

    let committed_lease_id = lease.id;
    launch_committed_runtime_lease(
        state,
        project_id,
        provider,
        scope,
        origin_options,
        runtime,
        lease,
        origin_info,
        origin_instance_id,
        provider_cfg,
        launch_metadata,
        provider_launch_admission,
    )
    .await
    .map_err(|error| with_committed_lease_id(error, committed_lease_id))
}

/// The error detail that names the lease generation an ensure had committed
/// before it failed.
const COMMITTED_LEASE_ID_DETAIL: &str = "leaseId";

/// Name the committed lease on an error from the rest of the launch.
///
/// Past the allocation commit the lease row is visible as the runtime's live
/// generation, and not every failure below marks it failed: a token or launch
/// guard error leaves it launching until the launch-timeout sweep. A caller
/// that reads the runtime's lease after the error, as the dispatch reconnect
/// does, needs this to tell its own dead launch from another start that is
/// really in flight.
fn with_committed_lease_id(
    (status, Json(mut error)): (StatusCode, Json<ApiError>),
    lease_id: Uuid,
) -> (StatusCode, Json<ApiError>) {
    let details = error
        .details
        .get_or_insert_with(|| JsonValue::Object(serde_json::Map::new()));
    if let Some(details) = details.as_object_mut() {
        details
            .entry(COMMITTED_LEASE_ID_DETAIL)
            .or_insert_with(|| JsonValue::String(lease_id.to_string()));
    }
    (status, Json(error))
}

/// The lease generation a failed ensure had already committed, or tried to
/// commit when the commit itself reported the error, if it got that far.
pub(crate) fn ensure_error_committed_lease_id(error: &ApiError) -> Option<Uuid> {
    error
        .details
        .as_ref()?
        .get(COMMITTED_LEASE_ID_DETAIL)?
        .as_str()
        .and_then(|value| Uuid::parse_str(value).ok())
}

/// The part of a launch that runs after its lease generation is committed.
/// Every error it returns is tagged with that lease by the caller.
#[allow(clippy::too_many_arguments)]
async fn launch_committed_runtime_lease(
    state: &AppState,
    project_id: Uuid,
    provider: String,
    scope: RuntimeLeaseScope,
    origin_options: OriginEnsureOptions,
    runtime: RuntimeRecord,
    lease: RuntimeLeaseRecord,
    origin_info: Option<RuntimeEnsureOriginInfo>,
    origin_instance_id: Option<Uuid>,
    provider_cfg: Option<crate::config::RuntimeProviderConfig>,
    launch_metadata: Option<JsonValue>,
    provider_launch_admission: Option<tokio::sync::SemaphorePermit<'static>>,
) -> Result<RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
    let runtime_uuid = runtime.id;
    let MintedAccessToken {
        token: runtime_token,
        ..
    } = mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: runtime.id.to_string(),
            subject: state
                .config
                .service_runtime_user_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "runtime.service".to_string()),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime.id.to_string()),
            protocol: None,
            scopes: default_runtime_token_scopes(),
            lease_id: Some(lease.id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: None,
        },
    )?;

    let response = RuntimeEnsureResponse {
        runtime_id: runtime.id.to_string(),
        status: runtime.status.clone(),
        provider: runtime.provider.clone(),
        lease_id: lease.id.to_string(),
        parent_lease_id: None,
        scope: Some(scope.as_str().to_string()),
        origin: origin_info.clone(),
    };

    // Self-hosted runtimes are launched externally (CLI/desktop); skip allocator.
    if crate::provider_identifiers::is_self_hosted_provider_id(&provider) {
        info!(
            %project_id,
            provider = %provider,
            runtime_id = %runtime.id,
            lease_id = %lease.id,
            "skipping external ensure for self-hosted runtime; awaiting agent register"
        );
        return Ok(response);
    }

    let provider_cfg = provider_cfg.ok_or_else(|| {
        internal_error("external runtime provider routing was not resolved before allocation")
    })?;

    if crate::provider_identifiers::is_self_hosted_provider_kind(&provider_cfg.kind) {
        info!(
            %project_id,
            provider = %provider,
            provider_kind = %provider_cfg.kind,
            runtime_id = %runtime.id,
            lease_id = %lease.id,
            "skipping external ensure for self-hosted provider; awaiting agent register"
        );
        return Ok(response);
    }

    let merged_metadata = super::managed::canonicalize_managed_runtime_env_values(
        &provider,
        merge_provider_metadata(&launch_metadata, &provider_cfg.metadata),
    );
    let managed_transport_metadata = apply_controller_turn_credentials(
        state.config.browser_turn_rest.as_ref(),
        project_id,
        runtime.id,
        Utc::now().timestamp(),
        merged_metadata,
    );
    let allocator_metadata = apply_browser_profile_persistence_policy(
        &state.config,
        project_id,
        apply_git_remote_env(&state.config, project_id, managed_transport_metadata),
    );

    // The allocation rows are visible now, which the launched runtime needs in
    // order to register. Acquire a second runtime -> lease -> project guard and
    // keep it through the provider call. Without it, stop or tombstone cleanup
    // could complete provider release before the delayed ensure recreates the
    // container.
    let mut launch_guard_connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Runtime provider launch guard", error))?;
    let launch_guard = launch_guard_connection
        .transaction()
        .await
        .map_err(|error| database_unavailable("Runtime provider launch guard", error))?;
    if let Err(error) = ensure_runtime_lease_available_for_provider_launch(
        &launch_guard,
        &project_id,
        &runtime.id,
        &lease.id,
        &provider,
    )
    .await
    {
        if let Err(rollback_error) = launch_guard.rollback().await {
            warn!(
                %project_id,
                runtime_id = %runtime.id,
                lease_id = %lease.id,
                %rollback_error,
                "failed to release stale runtime provider launch guard"
            );
        }
        drop(launch_guard_connection);
        drop(provider_launch_admission);
        return Err(error);
    }
    if let Err(error) =
        ensure_project_available_for_runtime_launch(&launch_guard, &project_id).await
    {
        if let Err(rollback_error) = launch_guard.rollback().await {
            warn!(
                %project_id,
                runtime_id = %runtime.id,
                %rollback_error,
                "failed to release runtime provider launch guard after project tombstone"
            );
        }
        drop(launch_guard_connection);
        drop(provider_launch_admission);
        match mark_runtime_launch_failed_if_current(
            state,
            &project_id,
            &runtime.id,
            &lease.id,
            &provider,
        )
        .await
        {
            Ok(true) => {}
            Ok(false) => info!(
                %project_id,
                provider = %provider,
                lease_id = %lease.id,
                "runtime stop superseded project-tombstone launch cleanup"
            ),
            Err(update_error) => warn!(
                %project_id,
                provider = %provider,
                lease_id = %lease.id,
                %update_error,
                "failed to roll back runtime state after project tombstone"
            ),
        }
        return Err(error);
    }

    let provider_result = call_provider_endpoint(
        state,
        &provider_cfg,
        "/runtime/ensure",
        &ProviderEnsureRequest {
            project_id: &project_id,
            runtime_id: &runtime.id,
            lease_id: &lease.id,
            provider: provider_cfg.id.as_str(),
            runtime_token: runtime_token.as_str(),
            metadata: allocator_metadata.as_ref(),
            origin_instance_id: origin_instance_id.as_ref(),
            origin_mode: origin_options.mode.as_ref(),
            origin_protocols: origin_options.protocols.clone(),
            origin_metadata: origin_options.metadata.as_ref(),
        },
        RUNTIME_PROVIDER_ENSURE_FENCE_TIMEOUT,
    )
    .await;

    // On success the guard is read-only and can be rolled back cheaply. A
    // provider error is ambiguous, however: before releasing the row locks,
    // quarantine the exact lease so late registration and subsequent ensure
    // requests fail closed while provider cleanup is in flight.
    let quarantine_error = if provider_result.is_err() {
        match mark_runtime_launch_cleanup_pending(
            &launch_guard,
            &project_id,
            &runtime.id,
            &lease.id,
            &provider,
        )
        .await
        {
            Ok(()) => match launch_guard.commit().await {
                Ok(()) => None,
                Err(error) => Some(format!(
                    "failed to commit ambiguous runtime launch quarantine: {error}"
                )),
            },
            Err((status, payload)) => {
                let message = format!(
                    "failed to quarantine ambiguous runtime launch ({status}): {}",
                    payload.0.message
                );
                if let Err(rollback_error) = launch_guard.rollback().await {
                    warn!(
                        %project_id,
                        runtime_id = %runtime.id,
                        %rollback_error,
                        "failed to release runtime provider launch guard after quarantine error"
                    );
                }
                Some(message)
            }
        }
    } else {
        if let Err(rollback_error) = launch_guard.rollback().await {
            warn!(
                %project_id,
                runtime_id = %runtime.id,
                %rollback_error,
                "failed to release runtime provider launch guard"
            );
        }
        None
    };
    drop(launch_guard_connection);
    drop(provider_launch_admission);

    // Provider errors are ambiguous: the remote allocator may still complete
    // after its HTTP response is lost or after our bounded ensure future is
    // cancelled. Compensate outside the database fence. The provider service
    // serializes ensure/release per runtime, so this release runs after any
    // late allocator completion and removes the result deterministically.
    let compensation_error = if provider_result.is_err() {
        match call_provider_endpoint(
            state,
            &provider_cfg,
            "/runtime/release",
            &ProviderReleaseRequest {
                project_id: &project_id,
                runtime_id: &runtime.id,
                lease_id: Some(&lease.id),
            },
            RUNTIME_PROVIDER_COMPENSATING_RELEASE_TIMEOUT,
        )
        .await
        {
            Ok(_) => None,
            Err(error) => Some(error.to_string()),
        }
    } else {
        None
    };

    match provider_result {
        Ok(message) => {
            if let Some(message) = message {
                info!(%project_id, provider = %provider, %message, "runtime provider ensure completed");
            }
        }
        Err(error) => {
            let mut error_message = error.to_string();
            if let Some(quarantine_error) = quarantine_error.as_deref() {
                error_message.push_str("; ");
                error_message.push_str(quarantine_error);
            }
            if let Some(compensation_error) = compensation_error.as_deref() {
                error_message.push_str("; ");
                error_message.push_str(compensation_error);
            }
            warn!(%project_id, provider = %provider, error = %error_message, "runtime provider failed to ensure runtime");
            if compensation_error.is_none() {
                match mark_runtime_launch_failed_if_current(
                    state,
                    &project_id,
                    &runtime.id,
                    &lease.id,
                    &provider,
                )
                .await
                {
                    Ok(true) => {}
                    Ok(false) => info!(
                        %project_id,
                        provider = %provider,
                        lease_id = %lease.id,
                        "runtime stop superseded provider-failure launch cleanup"
                    ),
                    Err(update_error) => warn!(
                        %project_id,
                        provider = %provider,
                        lease_id = %lease.id,
                        %update_error,
                        "failed to update lease state after provider failure"
                    ),
                }
            } else if quarantine_error.is_none() {
                warn!(
                    %project_id,
                    provider = %provider,
                    lease_id = %lease.id,
                    "ambiguous failed launch remains quarantined for strict launch-timeout cleanup"
                );
            } else {
                match mark_runtime_launch_cleanup_pending_if_current(
                    state,
                    &project_id,
                    &runtime.id,
                    &lease.id,
                    &provider,
                )
                .await
                {
                    Ok(true) => warn!(
                        %project_id,
                        provider = %provider,
                        lease_id = %lease.id,
                        "quarantined ambiguous failed launch after the in-fence transition failed"
                    ),
                    Ok(false) => info!(
                        %project_id,
                        provider = %provider,
                        lease_id = %lease.id,
                        "runtime stop or an earlier quarantine superseded launch cleanup retry"
                    ),
                    Err(update_error) => warn!(
                        %project_id,
                        provider = %provider,
                        lease_id = %lease.id,
                        %update_error,
                        "failed to quarantine ambiguous runtime launch after compensating release failure"
                    ),
                }
            }
            if let Err(report_error) = record_system_bug_report(
                state,
                SystemBugReportInput {
                    message: format!("Hosted runtime provider failed for {provider}"),
                    details: Some(error_message.clone()),
                    project_id: Some(project_id),
                    runtime_id: Some(runtime.id),
                    run_id: None,
                    conversation_id: None,
                    priority: "high".to_string(),
                    labels: vec![
                        "runtime".to_string(),
                        "provider".to_string(),
                        "monitoring".to_string(),
                    ],
                    metadata: json!({
                        "source": "runtime.ensure",
                        "provider": provider.clone(),
                        "leaseId": lease.id.to_string(),
                        "runtimeId": runtime.id.to_string(),
                        "projectId": project_id.to_string(),
                    }),
                    logs: json!([
                        {
                            "kind": "runtime.provider.ensure_failed",
                            "provider": provider.clone(),
                            "runtimeId": runtime.id.to_string(),
                            "leaseId": lease.id.to_string(),
                            "error": error_message.clone(),
                        }
                    ]),
                    fingerprint: Some(format!("runtime.ensure.provider.{provider}")),
                    dedupe_window_seconds: Some(15 * 60),
                },
            )
            .await
            {
                warn!(
                    %project_id,
                    provider = %provider,
                    runtime_id = %runtime.id,
                    %report_error,
                    "failed to record runtime provider failure bug report"
                );
            }
            let public_message = if compensation_error.is_some() {
                format!("provider failed to ensure runtime {runtime_uuid}; cleanup remains pending")
            } else {
                format!("provider failed to ensure runtime {runtime_uuid}")
            };
            // The provider's own text is in the bug report above; this is the
            // one rebuild on the hosted-launch path, and without a code the
            // most common hosted failure would reach the automation notice
            // with no discriminator at all. Status and public message are
            // unchanged. Deliberately coarse: a provider timeout and a
            // provider 500 are already collapsed upstream.
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError::with_details(
                    public_message,
                    "provider_launch_failed",
                    json!({ "runtimeId": runtime_uuid.to_string() }),
                )),
            ));
        }
    }

    Ok(response)
}

/// `host_project_id` is the project `authorize_tenant_host_runtime` authorized
/// the caller for in an earlier transaction. Once the runtime is locked, it
/// must still belong to that project, and the caller's write access to the
/// project is checked again in this transaction: access revoked in between
/// refuses the attach.
///
/// The attach leaves the runtime's origin alone. That origin belongs to the
/// host project, which requests and registers it for its shared lease; the
/// response reports it as it is.
async fn ensure_runtime_tenant(
    state: &AppState,
    project_id: Uuid,
    runtime_id: Uuid,
    host_project_id: Uuid,
    metadata: Option<JsonValue>,
    context: &RequestContext,
) -> Result<RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
    let mut conn = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Runtime lease", error))?;
    let transaction = conn
        .transaction()
        .await
        .map_err(|error| database_unavailable("Runtime lease", error))?;

    ensure_project_exists(&transaction, &project_id, state.config.auto_create_projects).await?;

    let runtime = fetch_runtime_for_update(&transaction, &runtime_id)
        .await
        .map_err(as_tenant_runtime_not_found)?;
    if runtime.project_id != host_project_id {
        return Err(tenant_runtime_not_found());
    }
    ensure_tenant_host_write_access(&transaction, &runtime.project_id, context).await?;
    if super::access::runtime_is_private_self_hosted(
        state,
        &runtime.provider,
        &runtime.capabilities,
    ) {
        return Err(forbidden(
            "private self-hosted runtimes cannot be attached as shared tenants",
        ));
    }
    let Some(shared_lease_id) = runtime.active_lease_id else {
        return Err(bad_request("runtime does not have an active shared lease"));
    };
    let shared_lease = fetch_runtime_lease_for_update(&transaction, &shared_lease_id).await?;
    if shared_lease.scope != RuntimeLeaseScope::Shared {
        return Err(bad_request("runtime active lease is not marked as shared"));
    }
    if shared_lease.released_at.is_some() {
        return Err(bad_request(
            "runtime shared lease has already been released",
        ));
    }
    if shared_lease.status.as_str() != "active" {
        return Err(bad_request("runtime shared lease is not active"));
    }

    // Both the first attach and a re-attach store only this.
    let metadata = super::managed::sanitize_tenant_lease_request_metadata(metadata);
    let metadata_for_event = metadata.clone();
    let tenant_lease = ensure_tenant_runtime_lease(
        &transaction,
        &project_id,
        &runtime_id,
        &shared_lease.id,
        metadata,
    )
    .await?;

    let origin_instance =
        load_origin_instance_for_lease(&transaction, &runtime.project_id, &shared_lease.id).await?;

    record_runtime_event(
        &transaction,
        &runtime.id,
        &runtime.project_id,
        "shared_tenant_linked",
        json!({
            "tenantProjectId": project_id,
            "tenantLeaseId": tenant_lease.id,
            "parentLeaseId": shared_lease.id,
            "metadata": metadata_for_event,
        }),
    )
    .await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit tenant lease: {error}")))?;

    let origin_info = origin_instance.as_ref().map(origin_info_from_record);

    Ok(RuntimeEnsureResponse {
        runtime_id: runtime.id.to_string(),
        status: runtime.status,
        provider: runtime.provider.clone(),
        lease_id: tenant_lease.id.to_string(),
        parent_lease_id: tenant_lease
            .parent_lease_id
            .map(|value| value.to_string())
            .or_else(|| Some(shared_lease.id.to_string())),
        scope: Some(RuntimeLeaseScope::Tenant.as_str().to_string()),
        origin: origin_info,
    })
}

/// Reuse the project's tenant lease under `parent_lease_id`, the runtime's
/// current shared lease, or create one. A tenant lease under an earlier shared
/// lease of the same runtime is never reused: its parent was released when the
/// runtime relaunched, and a lease left unreleased by then is stale.
async fn ensure_tenant_runtime_lease(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
    parent_lease_id: &Uuid,
    metadata: Option<JsonValue>,
) -> Result<RuntimeLeaseDetails, (StatusCode, Json<ApiError>)> {
    let metadata_ref = metadata.as_ref();
    if let Some(row) = transaction
        .query_opt(
            "select id, project_id, runtime_id, status, scope, parent_lease_id, released_at, metadata
             from runtime_leases
             where project_id = $1
               and runtime_id = $2
               and parent_lease_id = $3
               and scope = 'tenant'
               and released_at is null
               and status <> 'failed'
             order by requested_at desc
             limit 1
             for update",
            &[project_id, runtime_id, parent_lease_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load tenant lease: {error}")))?
    {
        let scope_value: String = row.get("scope");
        let lease_scope = RuntimeLeaseScope::from_db(&scope_value)?;
        let details = RuntimeLeaseDetails {
            id: row.get("id"),
            project_id: row.get("project_id"),
            runtime_id: row.get("runtime_id"),
            status: row.get("status"),
            scope: lease_scope,
            parent_lease_id: row.get("parent_lease_id"),
            released_at: row.get("released_at"),
            metadata: row.get("metadata"),
        };
        if let Some(meta) = metadata_ref {
            transaction
                .execute(
                    "update runtime_leases set metadata = $2::jsonb, updated_at = now() where id = $1",
                    &[&details.id, meta],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to update tenant lease metadata: {error}"))
                })?;
        }
        return Ok(details);
    }

    let record = create_runtime_lease(
        transaction,
        project_id,
        runtime_id,
        RuntimeLeaseScope::Tenant,
        Some(parent_lease_id),
        metadata,
        false,
    )
    .await?;

    mark_runtime_lease_active(transaction, &record.id).await?;

    let refreshed = fetch_runtime_lease_for_update(transaction, &record.id).await?;

    Ok(refreshed)
}

#[cfg(test)]
#[path = "ensure_concurrency_tests.rs"]
mod concurrency_tests;

#[cfg(test)]
#[path = "ensure_reclaim_tests.rs"]
mod reclaim_tests;

#[cfg(test)]
#[path = "ensure_tenant_tests.rs"]
mod tenant_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_runtime_limit_message_without_blocker_is_generic() {
        let message = format_hosted_runtime_limit_message(1, 1, None);
        assert!(message.contains("Instafy Cloud runtime limit reached"));
        assert!(message.contains("Stop another runtime or upgrade your plan."));
    }

    #[test]
    fn hosted_runtime_limit_message_with_blocker_includes_runtime_and_project() {
        let blocker = ActiveHostedRuntimeBlocker {
            runtime_id: Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap(),
            project_id: Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap(),
            project_name: Some("Acme Project".to_string()),
            display_name: Some("Runtime One".to_string()),
        };

        let message = format_hosted_runtime_limit_message(1, 1, Some(&blocker));
        assert!(message.contains("Runtime One"));
        assert!(message.contains("Acme Project"));
        assert!(message.contains("Stop/remove that runtime, then retry."));
        assert!(message.contains(&blocker.project_id.to_string()));
        assert!(message.contains(&blocker.runtime_id.to_string()));
    }

    #[test]
    fn hosted_runtime_limit_details_are_structured_for_clients() {
        let blocker = ActiveHostedRuntimeBlocker {
            runtime_id: Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap(),
            project_id: Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap(),
            project_name: Some("Acme Project".to_string()),
            display_name: Some("Runtime One".to_string()),
        };

        let details = hosted_runtime_limit_details(2, 2, Some(&blocker));
        let payload = serde_json::to_value(details).unwrap();
        assert_eq!(payload["activeCount"], 2);
        assert_eq!(payload["maxActiveCount"], 2);
        assert_eq!(payload["blockerRuntimeId"], blocker.runtime_id.to_string());
        assert_eq!(payload["blockerProjectId"], blocker.project_id.to_string());
        assert_eq!(payload["blockerRuntimeLabel"], "Runtime One");
        assert_eq!(payload["blockerProjectLabel"], "Acme Project");
    }

    #[test]
    fn platform_cap_of_zero_or_negative_never_blocks() {
        assert!(!platform_at_capacity(1_000, 0));
        assert!(!platform_at_capacity(1_000, -1));
    }

    #[test]
    fn platform_cap_blocks_at_and_over_the_ceiling() {
        assert!(!platform_at_capacity(11, 12));
        assert!(platform_at_capacity(12, 12));
        assert!(platform_at_capacity(13, 12));
    }

    #[test]
    fn platform_cap_fails_open_on_failed_count() {
        // A failed count is signaled as -1 and must never block, even under a cap.
        assert!(!platform_at_capacity(-1, 12));
    }

    #[test]
    fn requeued_runtime_metadata_preserves_existing_object_fields() {
        let runtime_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let existing = json!({
            "runtimeAgentImage": "runtime-agent:webdev",
            "env": {
                "INSTAFY_ENABLE_BROWSER_SESSION": "1",
                "INSTAFY_BROWSER_DISPLAY": ":1"
            },
            "source": "old_source"
        });

        let result = build_requeued_runtime_metadata(
            Some(&existing),
            runtime_id,
            "heartbeat_timeout_recovery",
        );
        let object = result.as_object().unwrap();
        assert_eq!(
            object
                .get("runtimeAgentImage")
                .and_then(JsonValue::as_str)
                .unwrap(),
            "runtime-agent:webdev"
        );
        let env = object.get("env").and_then(JsonValue::as_object).unwrap();
        assert_eq!(
            env.get("INSTAFY_ENABLE_BROWSER_SESSION")
                .and_then(JsonValue::as_str)
                .unwrap(),
            "1"
        );
        assert_eq!(
            object.get("source").and_then(JsonValue::as_str).unwrap(),
            "heartbeat_timeout_recovery"
        );
        assert_eq!(
            object
                .get("runtime_id")
                .and_then(JsonValue::as_str)
                .unwrap(),
            runtime_id.to_string()
        );
        assert_eq!(
            object.get("reason").and_then(JsonValue::as_str).unwrap(),
            "queued_jobs_after_runtime_stop"
        );
    }

    #[test]
    fn requeued_runtime_metadata_wraps_non_object_existing_metadata() {
        let runtime_id = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let existing = json!(["legacy", "metadata"]);

        let result = build_requeued_runtime_metadata(
            Some(&existing),
            runtime_id,
            "heartbeat_timeout_recovery",
        );
        let object = result.as_object().unwrap();
        assert_eq!(object.get("previous_metadata"), Some(&existing));
        assert_eq!(
            object.get("source").and_then(JsonValue::as_str).unwrap(),
            "heartbeat_timeout_recovery"
        );
    }

    /// The live lease's metadata the way the launch path stores it for a
    /// webdev launch of generation `lease_id`.
    fn webdev_lease_metadata(lease_id: Uuid) -> JsonValue {
        json!({
            "runtimeFlavor": "webdev",
            "source": "browser-session",
            "sizeId": "boost",
            "env": {
                "INSTAFY_ENABLE_BROWSER_SESSION": "1",
                "RUNTIME_CPU_LIMIT": "4",
                "RUNTIME_MEMORY_LIMIT": "8g",
            },
            "_instafyManagedRuntimeLaunch": {
                "version": 1,
                "flavor": "webdev",
                "generation": lease_id.to_string(),
            },
        })
    }

    /// What reuse of `lease_id` decides for a reconnect with `requested`, run
    /// through the same sanitizing the launch path applies first.
    fn reuse_decision(
        requested: JsonValue,
        lease_metadata: &JsonValue,
        lease_id: Uuid,
    ) -> Result<Option<JsonValue>, &'static str> {
        let sanitized = super::super::managed::sanitize_managed_runtime_request_metadata(
            "instafy-cloud",
            Some(requested),
        )?;
        let (sanitized, _) = normalize_runtime_size_metadata(sanitized);
        super::super::managed::reconcile_reused_managed_runtime_metadata(
            "instafy-cloud",
            sanitized,
            Some(lease_metadata),
            lease_id,
        )
    }

    #[test]
    fn dispatch_reconnect_reuses_a_live_webdev_runtime_with_its_launch_settings() {
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let lease_metadata = webdev_lease_metadata(lease_id);

        // Before, the reconnect named no flavor, and reuse refused it.
        let bare = json!({
            "source": "dispatch_runtime_alert",
            "runtimeId": runtime_id,
            "forceNewLease": false,
        });
        assert!(reuse_decision(bare, &lease_metadata, lease_id).is_err());

        let requested = build_dispatch_reconnect_metadata(
            "instafy-cloud",
            Some((lease_id, Some(&lease_metadata))),
            None,
            runtime_id,
            "dispatch_runtime_alert",
            false,
        );
        assert_eq!(requested["runtimeFlavor"], "webdev");
        assert_eq!(requested["source"], "dispatch_runtime_alert");
        assert_eq!(requested["runtimeId"], runtime_id.to_string());
        assert_eq!(requested["forceNewLease"], false);
        assert!(requested.get("_instafyManagedRuntimeLaunch").is_none());

        let reused = reuse_decision(requested, &lease_metadata, lease_id)
            .expect("a reconnect reuses the live webdev lease")
            .expect("reused metadata");
        assert!(super::super::managed::managed_webdev_launch_is_attested(
            "instafy-cloud",
            Some(&reused),
            lease_id,
        ));
        // The reused lease keeps the size billing reads and the browser env a
        // requeue relaunches with.
        assert_eq!(reused["sizeId"], "boost");
        assert_eq!(reused["env"]["INSTAFY_ENABLE_BROWSER_SESSION"], "1");
        assert_eq!(reused["env"]["RUNTIME_MEMORY_LIMIT"], "8g");
    }

    #[test]
    fn dispatch_reconnect_flavor_follows_the_live_lease_attestation() {
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();

        // A base lease, even one whose stored field says webdev without the
        // controller's attestation, is reused as base.
        for base_metadata in [
            json!({ "source": "studio", "sizeId": "standard" }),
            json!({ "runtimeFlavor": "webdev", "sizeId": "standard" }),
            webdev_lease_metadata(Uuid::new_v4()),
        ] {
            let requested = build_dispatch_reconnect_metadata(
                "instafy-cloud",
                Some((lease_id, Some(&base_metadata))),
                None,
                runtime_id,
                "dispatch_runtime_alert",
                false,
            );
            assert!(requested.get("runtimeFlavor").is_none(), "{requested}");
            assert!(
                reuse_decision(requested, &base_metadata, lease_id).is_ok(),
                "{base_metadata}"
            );
        }

        // No live lease: nothing to inherit.
        let requested = build_dispatch_reconnect_metadata(
            "instafy-cloud",
            None,
            None,
            runtime_id,
            "dispatch_runtime_alert",
            true,
        );
        assert_eq!(
            requested,
            json!({
                "source": "dispatch_runtime_alert",
                "runtimeId": runtime_id.to_string(),
                "forceNewLease": true,
            })
        );

        // Only the exact managed provider honors the attestation.
        let requested = build_dispatch_reconnect_metadata(
            "acme-provider",
            Some((lease_id, Some(&webdev_lease_metadata(lease_id)))),
            None,
            runtime_id,
            "dispatch_runtime_alert",
            false,
        );
        assert!(requested.get("runtimeFlavor").is_none(), "{requested}");
        assert_eq!(requested["sizeId"], "boost");
    }

    /// What a new lease `lease_id` launches with for a request, through the
    /// same steps the launch path takes.
    fn new_launch_metadata(requested: JsonValue, lease_id: Uuid) -> JsonValue {
        let sanitized = super::super::managed::sanitize_managed_runtime_request_metadata(
            "instafy-cloud",
            Some(requested),
        )
        .expect("a reconnect request passes the managed request boundary");
        let (sanitized, _) = normalize_runtime_size_metadata(sanitized);
        super::super::managed::attest_new_managed_runtime_launch(
            "instafy-cloud",
            sanitized,
            lease_id,
        )
        .expect("managed launch metadata")
    }

    #[test]
    fn dispatch_reconnect_relaunches_an_ended_webdev_lease_as_webdev_at_the_standard_size() {
        let runtime_id = Uuid::new_v4();
        let ended_lease_id = Uuid::new_v4();
        // A webdev Boost lease stopped for idling, whose browser also asked
        // for a CDP screencast in a viewport-only window. Its TURN
        // credentials were injected by the controller for that lease.
        let mut ended_metadata = webdev_lease_metadata(ended_lease_id);
        ended_metadata["env"]["INSTAFY_BROWSER_CDP_SCREENCAST"] = json!("1");
        ended_metadata["env"]["INSTAFY_BROWSER_VIEWPORT_ONLY"] = json!("1");
        ended_metadata["env"]["INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"] =
            json!("[{\"urls\":\"turn:stale.example\"}]");
        ended_metadata["env"]["INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"] = json!("1");

        let requested = build_dispatch_reconnect_metadata(
            "instafy-cloud",
            None,
            Some((ended_lease_id, Some(&ended_metadata))),
            runtime_id,
            "dispatch_runtime_alert",
            true,
        );
        // The image and the browser settings a client may ask for; not the
        // size, the resource limits or the old lease's TURN credentials.
        assert_eq!(
            requested,
            json!({
                "runtimeFlavor": "webdev",
                "env": {
                    "INSTAFY_ENABLE_BROWSER_SESSION": "1",
                    "INSTAFY_BROWSER_CDP_SCREENCAST": "1",
                    "INSTAFY_BROWSER_VIEWPORT_ONLY": "1",
                },
                "source": "dispatch_runtime_alert",
                "runtimeId": runtime_id.to_string(),
                "forceNewLease": true,
            })
        );

        let successor_id = Uuid::new_v4();
        let launched = new_launch_metadata(requested, successor_id);
        assert!(super::super::managed::managed_webdev_launch_is_attested(
            "instafy-cloud",
            Some(&launched),
            successor_id,
        ));
        assert_eq!(launched["sizeId"], "standard");
        assert_eq!(launched["env"]["RUNTIME_CPU_LIMIT"], "2");
        assert_eq!(launched["env"]["RUNTIME_MEMORY_LIMIT"], "4g");
        assert_eq!(launched["env"]["INSTAFY_ENABLE_BROWSER_SESSION"], "1");
        assert_eq!(launched["env"]["INSTAFY_BROWSER_CDP_SCREENCAST"], "1");
        assert_eq!(launched["env"]["INSTAFY_BROWSER_VIEWPORT_ONLY"], "1");
        assert_ne!(
            launched["env"].get("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"),
            ended_metadata["env"].get("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON"),
            "the old lease's TURN credentials never carry over: {launched}"
        );

        // A webdev launch without the browser switch comes back without it.
        let mut switchless = webdev_lease_metadata(ended_lease_id);
        switchless["env"]
            .as_object_mut()
            .expect("env")
            .remove("INSTAFY_ENABLE_BROWSER_SESSION");
        let requested = build_dispatch_reconnect_metadata(
            "instafy-cloud",
            None,
            Some((ended_lease_id, Some(&switchless))),
            runtime_id,
            "dispatch_runtime_alert",
            true,
        );
        assert_eq!(requested["runtimeFlavor"], "webdev");
        assert!(requested.get("env").is_none(), "{requested}");
    }

    #[test]
    fn dispatch_reconnect_takes_an_ended_lease_flavor_only_from_its_own_attestation() {
        let runtime_id = Uuid::new_v4();
        let ended_lease_id = Uuid::new_v4();
        let bare = json!({
            "source": "dispatch_runtime_alert",
            "runtimeId": runtime_id.to_string(),
            "forceNewLease": true,
        });

        for (provider, ended_metadata) in [
            // A base Boost launch.
            (
                "instafy-cloud",
                Some(json!({
                    "source": "studio",
                    "sizeId": "boost",
                    "env": { "RUNTIME_CPU_LIMIT": "4", "RUNTIME_MEMORY_LIMIT": "8g" },
                })),
            ),
            // A stored flavor the controller never attested.
            (
                "instafy-cloud",
                Some(json!({
                    "runtimeFlavor": "webdev",
                    "sizeId": "boost",
                    "env": { "INSTAFY_ENABLE_BROWSER_SESSION": "1" },
                })),
            ),
            // An attestation copied from another generation.
            ("instafy-cloud", Some(webdev_lease_metadata(Uuid::new_v4()))),
            ("instafy-cloud", None),
            // Only the exact managed provider honors the attestation.
            ("acme-provider", Some(webdev_lease_metadata(ended_lease_id))),
        ] {
            let requested = build_dispatch_reconnect_metadata(
                provider,
                None,
                Some((ended_lease_id, ended_metadata.as_ref())),
                runtime_id,
                "dispatch_runtime_alert",
                true,
            );
            assert_eq!(requested, bare, "{provider}: {ended_metadata:?}");
        }

        let launched = new_launch_metadata(bare, Uuid::new_v4());
        assert!(launched.get("runtimeFlavor").is_none(), "{launched}");
        assert!(launched.get("_instafyManagedRuntimeLaunch").is_none());
        assert_eq!(launched["sizeId"], "standard");

        // A live lease decides on its own; an older ended lease adds nothing.
        let live_lease_id = Uuid::new_v4();
        let live_metadata = json!({ "source": "studio", "sizeId": "standard" });
        let ended_metadata = webdev_lease_metadata(ended_lease_id);
        let requested = build_dispatch_reconnect_metadata(
            "instafy-cloud",
            Some((live_lease_id, Some(&live_metadata))),
            Some((ended_lease_id, Some(&ended_metadata))),
            runtime_id,
            "dispatch_runtime_alert",
            false,
        );
        assert!(requested.get("runtimeFlavor").is_none(), "{requested}");
        assert!(requested.get("env").is_none(), "{requested}");
    }

    #[test]
    fn carried_settings_only_apply_to_the_lease_they_were_read_from() {
        let read_lease = Uuid::new_v4();
        let other_lease = Uuid::new_v4();

        assert!(ReusedLeaseMetadata::Requested.applies_to_reused_lease(read_lease));
        assert!(
            ReusedLeaseMetadata::CarriedFrom(Some(read_lease)).applies_to_reused_lease(read_lease)
        );
        // Another generation, or one that appeared after the reconnect found
        // no live lease, keeps its own settings.
        assert!(!ReusedLeaseMetadata::CarriedFrom(Some(read_lease))
            .applies_to_reused_lease(other_lease));
        assert!(!ReusedLeaseMetadata::CarriedFrom(None).applies_to_reused_lease(other_lease));
    }

    #[test]
    fn errors_after_the_lease_commit_name_the_committed_lease() {
        let lease_id = Uuid::new_v4();

        let (status, Json(error)) = with_committed_lease_id(
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError::new("origin token signing key not configured")),
            ),
            lease_id,
        );
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error.message, "origin token signing key not configured");
        assert_eq!(error.code, None);
        assert_eq!(ensure_error_committed_lease_id(&error), Some(lease_id));

        // Existing details, such as the provider failure's runtime id, stay.
        let runtime_id = Uuid::new_v4();
        let (_, Json(error)) = with_committed_lease_id(
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError::with_details(
                    "provider failed to ensure runtime",
                    "provider_launch_failed",
                    json!({ "runtimeId": runtime_id.to_string() }),
                )),
            ),
            lease_id,
        );
        assert_eq!(error.code.as_deref(), Some("provider_launch_failed"));
        assert_eq!(
            error.details,
            Some(json!({
                "runtimeId": runtime_id.to_string(),
                "leaseId": lease_id.to_string(),
            }))
        );
        assert_eq!(ensure_error_committed_lease_id(&error), Some(lease_id));

        // An error from before the commit names no lease.
        assert_eq!(
            ensure_error_committed_lease_id(&ApiError::new(
                "runtime cleanup is still pending; retry after the provider release completes",
            )),
            None
        );
    }
}
