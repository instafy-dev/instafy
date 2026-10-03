//! Keep a hosted workspace's work before the controller stops its runtime.
//!
//! A controller-driven stop of a provider-managed runtime quarantines it
//! first (its lease goes `cleanup_pending`, its origin instances are released,
//! its jobs are requeued) and then asks the provider to remove the machine,
//! often together with the checkout on it. Just before that, the controller
//! calls the runtime origin's `POST /git/flush`: finished local commits are
//! published by merge, unsaved edits and an unfinished turn are parked on
//! recovery refs, and parked refs are pushed. Nothing dirty or half-finished
//! reaches `main` from here.
//!
//! The origin needs `git.write` to push, and a runtime machine credential can
//! never mint it. The controller instead mints a short-lived `fs.write` origin
//! token for the holder of the project's active workspace lease, the same way
//! a GitHub import does. The origin exchanges that exact token for
//! `git.write`, which the controller grants only while the lease is active and
//! its holder may still write. When nobody holds a lease this runtime may
//! save under, the controller mints nothing for anyone and does not call the
//! origin (`no_writer`): the runtime's own shutdown flush keeps the work on
//! local recovery refs, the checkout is kept on the node while they exist,
//! and the next start pushes them.
//!
//! Best effort and bounded by [`PRE_STOP_FLUSH_TIMEOUT`]: a failure is logged,
//! recorded as a `workspace_flush` runtime event, and the stop goes on. Work
//! the flush could not push stays on the runtime's local recovery refs.

use std::time::Duration;

use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use tokio_postgres::Transaction;
use tracing::{info, warn};
use uuid::Uuid;

use crate::origins::{resolve_origin_proxy_upstream_endpoint, WorkspaceLeaseRecord};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use crate::{internal_error, ApiError, AppState};

use super::db::{record_runtime_event, RuntimeDetails};

/// The longest a stop waits for the origin's flush.
const PRE_STOP_FLUSH_TIMEOUT: Duration = Duration::from_secs(25);
/// Lifetime of the `fs.write` token the origin presents to mint `git.write`.
/// The mint happens at the start of the flush, so the token never needs to
/// outlive [`PRE_STOP_FLUSH_TIMEOUT`] by much.
const PRE_STOP_FLUSH_TOKEN_TTL_SECONDS: i64 = 60;

/// A hosted origin that should be flushed before its runtime stops.
#[derive(Debug, Clone)]
pub(super) struct PreStopFlushTarget {
    runtime_id: Uuid,
    project_id: Uuid,
    origin_id: Uuid,
    origin_endpoint: String,
    /// A turn is running on the runtime, or was cancelled moments before
    /// this stop: its local commits are unfinished and must not reach `main`.
    turn_active: bool,
    lease: WorkspaceLeaseState,
}

#[derive(Debug, Clone, Copy)]
enum WorkspaceLeaseState {
    /// The project's active workspace lease, held by someone this runtime's
    /// work may be saved under.
    Held(WorkspaceLeaseHolder),
    /// An active lease bound to another runtime, or with no user.
    Unusable,
    /// No active lease.
    Free,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkspaceLeaseHolder {
    lease_id: Uuid,
    user_id: Uuid,
    runtime_id: Option<Uuid>,
}

impl WorkspaceLeaseState {
    fn of(lease: Option<&WorkspaceLeaseRecord>, runtime_id: &Uuid) -> Self {
        let Some(lease) = lease else {
            return Self::Free;
        };
        match lease.user_id {
            Some(user_id) if lease.runtime_id.is_none_or(|bound| bound == *runtime_id) => {
                Self::Held(WorkspaceLeaseHolder {
                    lease_id: lease.id,
                    user_id,
                    runtime_id: lease.runtime_id,
                })
            }
            _ => Self::Unusable,
        }
    }
}

/// What a pre-stop flush did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PreStopFlushOutcome {
    /// The origin answered. `unpushed_refs` local recovery refs are still only
    /// on the runtime's disk.
    Flushed {
        unpushed_refs: usize,
        unpushed_ref_names: Vec<String>,
        recovery_refs: usize,
        parked_commits: usize,
        git_sync_status: Option<String>,
    },
    /// Nobody holds a workspace lease this runtime may save under, so no
    /// token was minted and the origin was not asked; the runtime's own
    /// shutdown flush keeps the work on local recovery refs.
    NoWriter,
    /// The origin was unreachable, refused, timed out or has no flush route.
    Failed(String),
}

impl PreStopFlushOutcome {
    fn status(&self) -> &'static str {
        match self {
            Self::Flushed {
                unpushed_refs: 0, ..
            } => "saved",
            Self::Flushed { .. } => "kept_locally",
            Self::NoWriter => "no_writer",
            Self::Failed(_) => "failed",
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginFlushReport {
    #[serde(default)]
    recovery_refs: Vec<JsonValue>,
    #[serde(default)]
    unpushed_refs: usize,
    #[serde(default)]
    unpushed_ref_names: Vec<String>,
    #[serde(default)]
    publish: Option<OriginFlushPublish>,
    #[serde(default)]
    parked_commits: usize,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginFlushPublish {
    #[serde(default)]
    git_sync_status: Option<String>,
}

/// The runtime's hosted origin and what the flush needs to know about it,
/// read inside the caller's stop-planning transaction. `None` when the
/// runtime has no online hosted (or EFS) origin for its current generation:
/// Desktop folders and self-hosted machines are never flushed.
pub(super) async fn find_target(
    transaction: &Transaction<'_>,
    runtime: &RuntimeDetails,
    runtime_lease_id: &Uuid,
) -> Result<Option<PreStopFlushTarget>, (StatusCode, Json<ApiError>)> {
    let Some(origin) = transaction
        .query_opt(
            "select o.id, o.endpoint
             from origin_instances oi
             join workspace_origins o
               on o.id = oi.origin_id
              and o.project_id = oi.project_id
             where oi.project_id = $1
               and oi.runtime_id = $2
               and oi.lease_id = $3
               and oi.status = 'online'
               and oi.mode in ('hosted', 'efs')
               and (cardinality(oi.protocols) = 0 or 'http' = any(oi.protocols))
             order by oi.updated_at desc
             limit 1",
            &[&runtime.project_id, &runtime.id, runtime_lease_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load the runtime origin: {error}")))?
    else {
        return Ok(None);
    };
    let origin_endpoint: String = origin.get("endpoint");
    if origin_endpoint.trim().is_empty() {
        return Ok(None);
    }

    // A turn the stop interrupts: a job still leased by this runtime, or one
    // cancelled in the last minute (a user Stop or a cancel the stop follows).
    let turn_active: bool = transaction
        .query_one(
            "select exists(
                select 1
                from agent_jobs
                where leased_by_runtime_id = $1
                  and project_id = $2
                  and (
                    status = 'leased'
                    or (status = 'canceled' and completed_at > now() - interval '60 seconds')
                  )
             )",
            &[&runtime.id, &runtime.project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check the runtime's turn: {error}")))?
        .get(0);

    let lease = transaction
        .query_opt(
            "select *
             from workspace_leases
             where project_id = $1
               and status = 'active'
               and expires_at > now()
             order by expires_at desc
             limit 1",
            &[&runtime.project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load the workspace lease: {error}")))?
        .map(|row| crate::origins::lease_from_row(&row));

    Ok(Some(PreStopFlushTarget {
        runtime_id: runtime.id,
        project_id: runtime.project_id,
        origin_id: origin.get("id"),
        origin_endpoint,
        turn_active,
        lease: WorkspaceLeaseState::of(lease.as_ref(), &runtime.id),
    }))
}

/// Ask the origin to flush, holding no database connection while it works.
/// Never fails: the outcome is logged and recorded as a runtime event.
/// Only the holder of the project's active workspace lease is minted a
/// token; nobody else's credential is ever used to save a stopping runtime.
pub(super) async fn flush(state: &AppState, target: PreStopFlushTarget) -> PreStopFlushOutcome {
    let outcome = match target.lease {
        WorkspaceLeaseState::Held(holder) => call_origin_flush(state, &target, &holder).await,
        WorkspaceLeaseState::Unusable | WorkspaceLeaseState::Free => PreStopFlushOutcome::NoWriter,
    };
    log_outcome(&target, &outcome);
    record_outcome(state, &target, &outcome).await;
    outcome
}

/// The short-lived `fs.write` origin token for the lease holder, minted the
/// way a GitHub import mints its origin token.
fn mint_flush_token(
    state: &AppState,
    target: &PreStopFlushTarget,
    holder: &WorkspaceLeaseHolder,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: target.origin_id.to_string(),
            subject: holder.user_id.to_string(),
            project_id: target.project_id.to_string(),
            origin_id: Some(target.origin_id.to_string()),
            runtime_id: holder.runtime_id.map(|id| id.to_string()),
            protocol: Some("http".to_string()),
            scopes: vec!["fs.write".to_string()],
            lease_id: Some(holder.lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(PRE_STOP_FLUSH_TOKEN_TTL_SECONDS),
        },
    )
    .map(|token| token.token)
}

async fn call_origin_flush(
    state: &AppState,
    target: &PreStopFlushTarget,
    holder: &WorkspaceLeaseHolder,
) -> PreStopFlushOutcome {
    let token = match mint_flush_token(state, target, holder) {
        Ok(token) => token,
        Err((_, body)) => return PreStopFlushOutcome::Failed(body.0.message),
    };
    let (origin_base, host_override) =
        resolve_origin_proxy_upstream_endpoint(&target.origin_endpoint);
    let mut request = state
        .origin_proxy_client
        .post(format!("{}/git/flush", origin_base.trim_end_matches('/')))
        .bearer_auth(&token)
        .timeout(PRE_STOP_FLUSH_TIMEOUT)
        .json(&json!({ "turnActive": target.turn_active }));
    if let Some(host) = host_override.filter(|host| !host.trim().is_empty()) {
        request = request.header("host", host);
    }

    let response = tokio::time::timeout(PRE_STOP_FLUSH_TIMEOUT, async move {
        let response = request.send().await?;
        let status = response.status();
        let body = response.bytes().await?;
        Ok::<_, reqwest::Error>((status, body))
    })
    .await;
    let (status, body) = match response {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return PreStopFlushOutcome::Failed(format!("origin flush request failed: {error}"))
        }
        Err(_) => {
            return PreStopFlushOutcome::Failed(format!(
                "origin flush timed out after {}s",
                PRE_STOP_FLUSH_TIMEOUT.as_secs()
            ))
        }
    };
    if !status.is_success() {
        let text = String::from_utf8_lossy(&body);
        let text: String = text.chars().take(300).collect();
        return PreStopFlushOutcome::Failed(format!(
            "origin flush answered {}: {text}",
            status.as_u16()
        ));
    }
    match serde_json::from_slice::<OriginFlushReport>(&body) {
        Ok(report) => PreStopFlushOutcome::Flushed {
            unpushed_refs: report.unpushed_refs.max(report.unpushed_ref_names.len()),
            unpushed_ref_names: report.unpushed_ref_names,
            recovery_refs: report.recovery_refs.len(),
            parked_commits: report.parked_commits,
            git_sync_status: report.publish.and_then(|publish| publish.git_sync_status),
        },
        Err(error) => {
            PreStopFlushOutcome::Failed(format!("origin flush response is invalid: {error}"))
        }
    }
}

fn log_outcome(target: &PreStopFlushTarget, outcome: &PreStopFlushOutcome) {
    match outcome {
        PreStopFlushOutcome::Flushed {
            unpushed_refs: 0,
            recovery_refs,
            parked_commits,
            git_sync_status,
            ..
        } => info!(
            runtime_id = %target.runtime_id,
            project_id = %target.project_id,
            origin_id = %target.origin_id,
            turn_active = target.turn_active,
            recovery_refs,
            parked_commits,
            git_sync_status = git_sync_status.as_deref().unwrap_or("none"),
            "kept the workspace's work on canonical before stopping the runtime"
        ),
        PreStopFlushOutcome::Flushed {
            unpushed_refs,
            unpushed_ref_names,
            recovery_refs,
            parked_commits,
            ..
        } => warn!(
            runtime_id = %target.runtime_id,
            project_id = %target.project_id,
            origin_id = %target.origin_id,
            turn_active = target.turn_active,
            unpushed_refs,
            ?unpushed_ref_names,
            recovery_refs,
            parked_commits,
            "workspace work is still only on the runtime's disk after the pre-stop flush"
        ),
        PreStopFlushOutcome::NoWriter => warn!(
            runtime_id = %target.runtime_id,
            project_id = %target.project_id,
            origin_id = %target.origin_id,
            turn_active = target.turn_active,
            "no workspace lease holder can save before the stop; the runtime keeps its work on local recovery refs"
        ),
        PreStopFlushOutcome::Failed(error) => warn!(
            runtime_id = %target.runtime_id,
            project_id = %target.project_id,
            origin_id = %target.origin_id,
            turn_active = target.turn_active,
            error = %error,
            "pre-stop workspace flush failed; the runtime keeps its work locally"
        ),
    }
}

async fn record_outcome(
    state: &AppState,
    target: &PreStopFlushTarget,
    outcome: &PreStopFlushOutcome,
) {
    let (unpushed_refs, recovery_refs, parked_commits, git_sync_status) = match outcome {
        PreStopFlushOutcome::Flushed {
            unpushed_refs,
            recovery_refs,
            parked_commits,
            git_sync_status,
            ..
        } => (
            Some(*unpushed_refs),
            Some(*recovery_refs),
            Some(*parked_commits),
            git_sync_status.clone(),
        ),
        _ => (None, None, None, None),
    };
    let data = json!({
        "status": outcome.status(),
        "turnActive": target.turn_active,
        "unpushedRefs": unpushed_refs,
        "recoveryRefs": recovery_refs,
        "parkedCommits": parked_commits,
        "gitSyncStatus": git_sync_status,
    });
    let result =
        async {
            let mut connection =
                state.pool.get().await.map_err(|error| {
                    internal_error(format!("failed to get a connection: {error}"))
                })?;
            let transaction = connection.transaction().await.map_err(|error| {
                internal_error(format!("failed to start a transaction: {error}"))
            })?;
            record_runtime_event(
                &transaction,
                &target.runtime_id,
                &target.project_id,
                "workspace_flush",
                data,
            )
            .await?;
            transaction
                .commit()
                .await
                .map_err(|error| internal_error(format!("failed to commit the event: {error}")))
        }
        .await;
    if let Err((_, body)) = result {
        warn!(
            runtime_id = %target.runtime_id,
            error = %body.0.message,
            "failed to record the pre-stop workspace flush"
        );
    }
}

#[cfg(test)]
#[path = "pre_stop_flush_tests.rs"]
mod db_tests;

#[cfg(test)]
mod tests {
    use super::{WorkspaceLeaseHolder, WorkspaceLeaseState};
    use crate::origins::WorkspaceLeaseRecord;
    use uuid::Uuid;

    fn lease(user_id: Option<Uuid>, runtime_id: Option<Uuid>) -> WorkspaceLeaseRecord {
        let now = chrono::Utc::now();
        WorkspaceLeaseRecord {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            user_id,
            runtime_id,
            status: "active".to_string(),
            acquired_at: now,
            expires_at: now,
            released_at: None,
            metadata: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn only_a_user_lease_this_runtime_may_write_under_is_used() {
        let runtime_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        assert!(matches!(
            WorkspaceLeaseState::of(None, &runtime_id),
            WorkspaceLeaseState::Free
        ));

        let own = lease(Some(user_id), Some(runtime_id));
        let WorkspaceLeaseState::Held(holder) = WorkspaceLeaseState::of(Some(&own), &runtime_id)
        else {
            panic!("the runtime's own lease is usable");
        };
        assert_eq!(
            holder,
            WorkspaceLeaseHolder {
                lease_id: own.id,
                user_id,
                runtime_id: Some(runtime_id),
            }
        );

        let neutral = lease(Some(user_id), None);
        assert!(matches!(
            WorkspaceLeaseState::of(Some(&neutral), &runtime_id),
            WorkspaceLeaseState::Held(WorkspaceLeaseHolder {
                runtime_id: None,
                ..
            })
        ));

        for unusable in [
            lease(Some(user_id), Some(Uuid::new_v4())),
            lease(None, Some(runtime_id)),
        ] {
            assert!(matches!(
                WorkspaceLeaseState::of(Some(&unusable), &runtime_id),
                WorkspaceLeaseState::Unusable
            ));
        }
    }
}
