//! Stopping what a deleted space still runs.
//!
//! Deleting a space marks it deleted and cancels its work in one transaction
//! (see [`crate::project_work_cancellation`]). Once that commits, the delete
//! hands the space to [`spawn_stop_runtimes_of_deleted_project`] without
//! waiting for it, since a hosted release can take minutes. The task
//! releases the space's workspace leases and its tenant leases on other
//! spaces' runtimes, stops every runtime of the space that still holds a
//! lease generation or runs, and revokes every tunnel grant the space still
//! has.
//!
//! Each stop is the controller's safe stop with reason `space_deleted`: a
//! hosted runtime is quarantined, released through its provider and then
//! finalized; a Desktop or self-hosted runtime has no provider to release it
//! and is stopped in the database only. Nothing is flushed first (see
//! [`super::pre_stop_flush`]), and no `runtime.stopped` is published: an
//! open tab takes a reason it does not know for an unexpected stop and
//! starts the machine again, and the space's deletion already told every
//! tab. After every stop, the work its quarantine requeued, or that reached
//! the space after the delete, is canceled.
//!
//! The idle sweep finishes what this task did not: after a restart, a
//! release that failed, or a grant the tunnel broker would not revoke (see
//! `stop_runtimes_of_deleted_projects` in [`super::sweeps`]).

use anyhow::Context;
use axum::http::StatusCode;
use axum::Json;
use tracing::{info, warn};
use uuid::Uuid;

use crate::project_work_cancellation::SPACE_DELETED_REASON;
use crate::{ApiError, AppState};

use super::pre_stop_flush::FlushPolicy;
use super::stop::{
    stop_runtime_safely_with, RuntimeIdentityExpectation, SafeRuntimeStop, StopOptions,
};

/// Stop everything the deleted space `project_id` still holds, in a task of
/// its own (see the module docs).
pub(crate) fn spawn_stop_runtimes_of_deleted_project(state: AppState, project_id: Uuid) {
    tokio::spawn(async move {
        stop_runtimes_of_deleted_project(&state, project_id).await;
    });
}

/// Release the leases of the deleted space `project_id`, stop each of its
/// runtimes that holds a lease generation or still runs, one after another,
/// and revoke its tunnel grants. Failures are logged, not returned: the idle
/// sweep retries them. Nothing happens to a space that is not deleted.
/// Returns how many runtimes it stopped.
pub(crate) async fn stop_runtimes_of_deleted_project(state: &AppState, project_id: Uuid) -> usize {
    release_leases_of_deleted_project(state, &project_id).await;

    let runtime_ids = match load_runtimes_to_stop(state, &project_id).await {
        Ok(runtime_ids) => runtime_ids,
        Err(error) => {
            warn!(
                project_id = %project_id,
                error = %format!("{error:#}"),
                "failed to load the runtimes of a deleted space"
            );
            Vec::new()
        }
    };
    let mut stopped = 0;
    for runtime_id in &runtime_ids {
        match stop_runtime_of_deleted_project(state, &project_id, runtime_id).await {
            Ok(SafeRuntimeStop { outcome, .. }) => {
                if outcome.status_changed {
                    stopped += 1;
                } else if let Some(reason) = outcome.skip_reason.as_deref() {
                    info!(
                        runtime_id = %runtime_id,
                        project_id = %project_id,
                        %reason,
                        "left a runtime of a deleted space as it was"
                    );
                }
            }
            Err((status, body)) => {
                warn!(
                    runtime_id = %runtime_id,
                    project_id = %project_id,
                    %status,
                    error = body.0.message,
                    "failed to stop a runtime of a deleted space"
                );
            }
        }
    }
    if runtime_ids.is_empty() {
        // No stop canceled what a dispatch queued after the delete.
        cancel_work_of_deleted_project(state, &project_id).await;
    }

    revoke_tunnels_of_deleted_project(state, &project_id).await;
    stopped
}

/// Stop `runtime_id`, a runtime of the deleted space `project_id` (a runtime
/// of another space is skipped as `runtime_identity_mismatch`), then cancel
/// the space's work again, whatever the stop did: its quarantine requeues
/// the jobs the runtime held before the release, which may then fail, and a
/// dispatch may have raced the delete. Tunnel grants are left to the
/// caller, which revokes all of the space's at once.
pub(super) async fn stop_runtime_of_deleted_project(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
) -> Result<SafeRuntimeStop, (StatusCode, Json<ApiError>)> {
    let stopped = stop_runtime_safely_with(
        state,
        runtime_id,
        StopOptions {
            source: SPACE_DELETED_REASON,
            reason: Some(SPACE_DELETED_REASON.to_string()),
            skip_if_active_jobs: false,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: Some(RuntimeIdentityExpectation {
                project_id: Some(*project_id),
                provider: None,
                display_name: None,
                lease_id: None,
            }),
        },
        // Never the owner's save-only permission (the space is not flushed
        // at all, see `pre_stop_flush::find_target`).
        FlushPolicy::REQUESTED,
    )
    .await;
    cancel_work_of_deleted_project(state, project_id).await;
    stopped
}

/// The runtimes of the deleted space `project_id` to stop: those holding a
/// lease generation (a hosted machine, a slot of the organization's hosted
/// limit) and those that still run without one. Read on a connection given
/// back before any stop.
async fn load_runtimes_to_stop(state: &AppState, project_id: &Uuid) -> anyhow::Result<Vec<Uuid>> {
    let connection = state
        .pool
        .get()
        .await
        .context("failed to get a connection to load a deleted space's runtimes")?;
    let rows = connection
        .query(
            "select r.id
             from runtimes r
             join projects p on p.id = r.project_id
             where r.project_id = $1
               and p.status = 'deleted'
               and (r.active_lease_id is not null
                    or r.status not in ('stopped', 'offline', 'removed'))
             order by r.id",
            &[project_id],
        )
        .await
        .context("failed to select a deleted space's runtimes")?;
    Ok(rows.iter().map(|row| row.get("id")).collect())
}

/// Release the workspace leases of the deleted space `project_id`, so no
/// origin saves under one any more, and its tenant leases, which attached it
/// to other spaces' runtimes; those runtimes keep running for their own
/// space. Nothing for a space that is not deleted. Logs a failure.
pub(super) async fn release_leases_of_deleted_project(state: &AppState, project_id: &Uuid) {
    let released = async {
        let connection = state
            .pool
            .get()
            .await
            .context("failed to get a connection to release a deleted space's leases")?;
        let workspace_leases = connection
            .execute(
                "update workspace_leases
                 set status = 'released', released_at = now(), updated_at = now()
                 where project_id = $1
                   and status = 'active'
                   and exists (select 1 from projects where id = $1 and status = 'deleted')",
                &[project_id],
            )
            .await
            .context("failed to release a deleted space's workspace leases")?;
        // Locks lease rows only, never a runtime row, so it cannot deadlock
        // with a stop that locks a runtime and then its leases.
        let tenant_leases = connection
            .execute(
                "update runtime_leases
                 set status = 'released', released_at = now(), updated_at = now()
                 where project_id = $1
                   and scope = 'tenant'
                   and released_at is null
                   and exists (select 1 from projects where id = $1 and status = 'deleted')",
                &[project_id],
            )
            .await
            .context("failed to release a deleted space's tenant leases")?;
        anyhow::Ok((workspace_leases, tenant_leases))
    }
    .await;
    match released {
        Ok((0, 0)) => {}
        Ok((workspace_leases, tenant_leases)) => info!(
            project_id = %project_id,
            workspace_leases,
            tenant_leases,
            "released the leases of a deleted space"
        ),
        Err(error) => warn!(
            project_id = %project_id,
            error = %format!("{error:#}"),
            "failed to release the leases of a deleted space"
        ),
    }
}

/// Revoke every tunnel grant the deleted space `project_id` still has. Logs
/// a failure; the idle sweep retries a space with an active grant.
pub(super) async fn revoke_tunnels_of_deleted_project(state: &AppState, project_id: &Uuid) {
    match crate::tunnels::revoke_tunnels_of_deleted_project(state, project_id, SPACE_DELETED_REASON)
        .await
    {
        Ok(0) => {}
        Ok(revoked) => info!(
            project_id = %project_id,
            revoked,
            "revoked the tunnel grants of a deleted space"
        ),
        Err((status, body)) => warn!(
            project_id = %project_id,
            %status,
            error = body.0.message,
            "failed to revoke every tunnel grant of a deleted space"
        ),
    }
}

async fn cancel_work_of_deleted_project(state: &AppState, project_id: &Uuid) {
    if let Err(error) =
        crate::project_work_cancellation::cancel_deleted_project_work(state, *project_id).await
    {
        warn!(
            project_id = %project_id,
            error = %format!("{error:#}"),
            "failed to cancel the work of a deleted space"
        );
    }
}

#[cfg(test)]
#[path = "deleted_project_stop_tests.rs"]
pub(super) mod db_tests;
