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
//! never mint it. The controller instead gives the origin one of two
//! short-lived credentials, which the origin exchanges for `git.write`:
//!
//! - the holder of the project's active workspace lease (bound to this
//!   runtime, or to no runtime) gets an `fs.write` token, minted the way a
//!   GitHub import mints its origin token, valid only while that lease is
//!   active and its holder may still write;
//! - when nobody holds such a lease, and only on the controller's own stop
//!   paths ([`super::stop`]'s safe stop, which the sweeps, reclaims and the
//!   pool-retirement drain use), the space owner gets a save-only permission
//!   ([`PRE_STOP_SAVE_SCOPE`]). It opens the origin's `/git/flush` and
//!   nothing else, takes no workspace lease (a user who opens the space
//!   meanwhile gets their own lease as usual), and is exchanged for
//!   `git.write` only while the runtime generation it names is still active
//!   and the owner may still write. Commits stay authored by the origin.
//!
//! Otherwise (`no_writer`: no owner, the owner lost write access, or a stop a
//! user or runtime asked for) the controller mints nothing and does not call
//! the origin: the runtime's own shutdown flush keeps the work on local
//! recovery refs, the checkout is kept on the node while they exist, and the
//! next start pushes them.
//!
//! Best effort and bounded by [`PRE_STOP_FLUSH_TIMEOUT`]: a failure is logged,
//! recorded as a `workspace_flush` runtime event, and the stop goes on. Work
//! the flush could not push stays on the runtime's local recovery refs.

use std::time::Duration;

use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::Transaction;
use tracing::{info, warn};
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::origins::{resolve_origin_proxy_upstream_endpoint, WorkspaceLeaseRecord};
use crate::projects::ensure_scoped_project_match;
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use crate::{
    ensure_project_write_access, forbidden, internal_error, load_project_record, unauthorized,
    ApiError, AppState,
};

use super::db::{record_runtime_event, RuntimeDetails};

/// The longest a stop waits for the origin's flush.
const PRE_STOP_FLUSH_TIMEOUT: Duration = Duration::from_secs(25);
/// Lifetime of the `fs.write` token the origin presents to mint `git.write`.
/// The mint happens at the start of the flush, so the token never needs to
/// outlive [`PRE_STOP_FLUSH_TIMEOUT`] by much.
const PRE_STOP_FLUSH_TOKEN_TTL_SECONDS: i64 = 60;
/// Lifetime of the owner's save-only permission (at most 120 s).
const PRE_STOP_SAVE_GRANT_TTL_SECONDS: i64 = 60;
/// The scope of the save-only permission the controller's own stop path
/// issues in the space owner's name when nobody holds a workspace lease. It
/// opens the runtime origin's `/git/flush` (the origin's
/// `PRE_STOP_SAVE_SCOPE`) and is exchanged for `git.write` only through
/// [`authorize_pre_stop_save_grant`].
pub(crate) const PRE_STOP_SAVE_SCOPE: &str = "workspace.flush";

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
    writer: FlushWriter,
}

/// Whose name the flush saves under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlushWriter {
    /// The holder of the project's active workspace lease.
    LeaseHolder(WorkspaceLeaseHolder),
    /// Nobody holds a lease this runtime may save under, and the controller
    /// stops the runtime on its own: the space owner's save-only permission,
    /// bound to this runtime generation.
    OwnerGrant {
        owner_user_id: Uuid,
        runtime_lease_id: Uuid,
    },
    /// Nobody may save: no token, no origin call.
    Nobody,
}

impl FlushWriter {
    fn label(&self) -> &'static str {
        match self {
            Self::LeaseHolder(_) => "lease_holder",
            Self::OwnerGrant { .. } => "owner_grant",
            Self::Nobody => "none",
        }
    }
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

/// What a stop did to keep the workspace's work, as the stop response
/// reports it (`flush`). `status` is `flushed` (the origin answered),
/// `no_writer` (nobody may save; the runtime keeps its work locally),
/// `failed` (the origin could not be reached or refused), `skipped` (the stop
/// itself is skipped) or `not_running` (no live hosted origin to flush).
/// `unpushedRefs` counts the local recovery refs still only on the runtime's
/// disk; `null` when unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlushSummary {
    pub(crate) status: &'static str,
    pub(crate) unpushed_refs: Option<usize>,
    pub(crate) unpushed_ref_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

impl FlushSummary {
    fn with_status(status: &'static str) -> Self {
        Self {
            status,
            unpushed_refs: None,
            unpushed_ref_names: Vec::new(),
            error: None,
        }
    }

    pub(crate) fn skipped() -> Self {
        Self::with_status("skipped")
    }

    pub(crate) fn not_running() -> Self {
        Self::with_status("not_running")
    }

    pub(crate) fn failed(error: impl Into<String>) -> Self {
        Self {
            error: Some(truncate(&error.into())),
            ..Self::with_status("failed")
        }
    }
}

fn truncate(text: &str) -> String {
    text.chars().take(300).collect()
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
    /// Nobody may save this runtime's work (see [`FlushWriter::Nobody`]), so
    /// no token was minted and the origin was not asked; the runtime's own
    /// shutdown flush keeps the work on local recovery refs.
    NoWriter,
    /// The origin was unreachable, refused, timed out or has no flush route.
    Failed(String),
}

impl PreStopFlushOutcome {
    pub(super) fn summary(&self) -> FlushSummary {
        match self {
            Self::Flushed {
                unpushed_refs,
                unpushed_ref_names,
                ..
            } => FlushSummary {
                status: "flushed",
                unpushed_refs: Some(*unpushed_refs),
                unpushed_ref_names: unpushed_ref_names.clone(),
                error: None,
            },
            Self::NoWriter => FlushSummary::with_status("no_writer"),
            Self::Failed(error) => FlushSummary::failed(error.clone()),
        }
    }

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
/// `owner_grant`: the controller stops this runtime on its own (never for a
/// user or runtime request), so without a lease holder the space owner's
/// save-only permission may be used.
pub(super) async fn find_target(
    transaction: &Transaction<'_>,
    runtime: &RuntimeDetails,
    runtime_lease_id: &Uuid,
    owner_grant: bool,
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

    let writer = match WorkspaceLeaseState::of(lease.as_ref(), &runtime.id) {
        WorkspaceLeaseState::Held(holder) => FlushWriter::LeaseHolder(holder),
        // A lease bound to another runtime (after a pool cutover, usually the
        // new node's) is not this runtime's writer either.
        WorkspaceLeaseState::Unusable | WorkspaceLeaseState::Free if owner_grant => {
            owner_writer(transaction, runtime, runtime_lease_id).await?
        }
        WorkspaceLeaseState::Unusable | WorkspaceLeaseState::Free => FlushWriter::Nobody,
    };

    Ok(Some(PreStopFlushTarget {
        runtime_id: runtime.id,
        project_id: runtime.project_id,
        origin_id: origin.get("id"),
        origin_endpoint,
        turn_active,
        writer,
    }))
}

/// The space owner, when they may still write to it.
async fn owner_writer(
    transaction: &Transaction<'_>,
    runtime: &RuntimeDetails,
    runtime_lease_id: &Uuid,
) -> Result<FlushWriter, (StatusCode, Json<ApiError>)> {
    let project = match load_project_record(transaction, &runtime.project_id).await {
        Ok(project) => project,
        Err((status, _)) if status == StatusCode::NOT_FOUND => return Ok(FlushWriter::Nobody),
        Err(error) => return Err(error),
    };
    let Some(owner_user_id) = project.owner_user_id else {
        return Ok(FlushWriter::Nobody);
    };
    let owner = owner_context(owner_user_id);
    match ensure_project_write_access(transaction, &project, &owner, None).await {
        Ok(_) => Ok(FlushWriter::OwnerGrant {
            owner_user_id,
            runtime_lease_id: *runtime_lease_id,
        }),
        Err((status, _))
            if matches!(
                status,
                StatusCode::FORBIDDEN | StatusCode::NOT_FOUND | StatusCode::UNAUTHORIZED
            ) =>
        {
            Ok(FlushWriter::Nobody)
        }
        Err(error) => Err(error),
    }
}

fn owner_context(owner_user_id: Uuid) -> RequestContext {
    RequestContext {
        user_id: Some(owner_user_id),
        is_service_role: false,
        scoped_claims: None,
    }
}

/// Ask the origin to flush, holding no database connection while it works.
/// Never fails: the outcome is logged and recorded as a runtime event.
/// Only the writer [`find_target`] chose gets a credential, and it goes to
/// this runtime's own origin and nowhere else.
pub(super) async fn flush(state: &AppState, target: PreStopFlushTarget) -> PreStopFlushOutcome {
    let token = match target.writer {
        FlushWriter::LeaseHolder(holder) => Some(mint_flush_token(state, &target, &holder)),
        FlushWriter::OwnerGrant {
            owner_user_id,
            runtime_lease_id,
        } => {
            info!(
                runtime_id = %target.runtime_id,
                project_id = %target.project_id,
                origin_id = %target.origin_id,
                "issuing the space owner's save-only permission for a stop nobody holds a workspace lease for"
            );
            Some(mint_save_grant(
                state,
                &target,
                owner_user_id,
                runtime_lease_id,
            ))
        }
        FlushWriter::Nobody => None,
    };
    let outcome = match token {
        Some(Ok(token)) => call_origin_flush(state, &target, &token).await,
        Some(Err((_, body))) => PreStopFlushOutcome::Failed(body.0.message),
        None => PreStopFlushOutcome::NoWriter,
    };
    log_outcome(&target, &outcome);
    record_outcome(state, &target, &outcome).await;
    outcome
}

/// The owner's save-only permission: scope [`PRE_STOP_SAVE_SCOPE`] for this
/// runtime's origin, bound to the project, the runtime and its lease
/// generation (`lease_id` is the runtime lease, not a workspace lease).
fn mint_save_grant(
    state: &AppState,
    target: &PreStopFlushTarget,
    owner_user_id: Uuid,
    runtime_lease_id: Uuid,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: target.origin_id.to_string(),
            subject: owner_user_id.to_string(),
            project_id: target.project_id.to_string(),
            origin_id: Some(target.origin_id.to_string()),
            runtime_id: Some(target.runtime_id.to_string()),
            protocol: Some("http".to_string()),
            scopes: vec![PRE_STOP_SAVE_SCOPE.to_string()],
            lease_id: Some(runtime_lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(PRE_STOP_SAVE_GRANT_TTL_SECONDS),
        },
    )
    .map(|token| token.token)
}

/// Where a save-only permission may push, once checked.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SaveGrantGitContext {
    pub(crate) owner_user_id: Uuid,
    pub(crate) runtime_id: Uuid,
    pub(crate) expires_at: DateTime<Utc>,
}

/// Check a save-only permission the origin presents to mint `git.write`:
/// exactly [`PRE_STOP_SAVE_SCOPE`], for this project and origin, whose
/// runtime generation is still the runtime's active, unquarantined one with
/// that origin online, and whose subject is still the space owner with write
/// access. The git token minted from it never outlives it.
pub(crate) async fn authorize_pre_stop_save_grant(
    state: &AppState,
    context: &RequestContext,
    project_id: &Uuid,
) -> Result<SaveGrantGitContext, (StatusCode, Json<ApiError>)> {
    let claims = context
        .scoped_claims
        .as_ref()
        .ok_or_else(|| unauthorized("save permission required"))?;
    ensure_scoped_project_match(context, project_id)?;
    if claims.scopes.len() != 1 || claims.scopes[0] != PRE_STOP_SAVE_SCOPE {
        return Err(forbidden(
            "a save permission carries the save scope and nothing else",
        ));
    }
    if claims.protocol.as_deref() != Some("http") {
        return Err(forbidden("save permission protocol is invalid"));
    }
    let parse = |value: Option<&str>, what: &str| {
        value
            .map(str::trim)
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(|| unauthorized(format!("save permission {what} is invalid")))
    };
    let origin_id = parse(claims.origin_id.as_deref(), "origin")?;
    if claims.aud.trim() != origin_id.to_string() {
        return Err(unauthorized("save permission audience is invalid"));
    }
    let runtime_id = parse(claims.runtime_id.as_deref(), "runtime")?;
    let runtime_lease_id = parse(claims.lease_id.as_deref(), "runtime generation")?;
    let owner_user_id = parse(Some(claims.sub.as_str()), "subject")?;
    let expires_at = DateTime::<Utc>::from_timestamp(claims.exp, 0)
        .ok_or_else(|| unauthorized("save permission expiry is invalid"))?;

    let mut connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to validate a save permission: {error}"))
    })?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!("failed to validate a save permission: {error}"))
    })?;
    let row = transaction
        .query_opt(
            "select r.status, r.active_lease_id, r.provider, r.capabilities,
                    l.status as lease_status, l.released_at, l.runtime_id as lease_runtime_id,
                    exists(
                        select 1
                        from origin_instances oi
                        where oi.project_id = r.project_id
                          and oi.runtime_id = r.id
                          and oi.lease_id = l.id
                          and oi.origin_id = $4
                          and oi.status = 'online'
                          and oi.mode in ('hosted', 'efs')
                    ) as origin_online
             from runtimes r
             join runtime_leases l on l.id = $3
             where r.id = $1 and r.project_id = $2
             for share of r",
            &[&runtime_id, project_id, &runtime_lease_id, &origin_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to validate a save permission: {error}")))?
        .ok_or_else(|| unauthorized("save permission runtime is no longer registered"))?;
    let status: String = row.get("status");
    let provider: String = row.get("provider");
    let capabilities: JsonValue = row.get("capabilities");
    let live_generation = row.get::<_, Option<Uuid>>("active_lease_id") == Some(runtime_lease_id)
        && row.get::<_, Option<Uuid>>("lease_runtime_id") == Some(runtime_id)
        && row.get::<_, String>("lease_status") == "active"
        && row.get::<_, Option<DateTime<Utc>>>("released_at").is_none()
        && matches!(status.as_str(), "ready" | "running" | "draining")
        && !super::access::runtime_is_private_self_hosted(state, &provider, &capabilities);
    if !live_generation {
        return Err(unauthorized(
            "save permission runtime generation is no longer active",
        ));
    }
    if !row.get::<_, bool>("origin_online") {
        return Err(unauthorized("save permission origin is no longer online"));
    }
    let project = load_project_record(&transaction, project_id).await?;
    if project.owner_user_id != Some(owner_user_id) {
        return Err(unauthorized(
            "save permission subject is no longer the space owner",
        ));
    }
    ensure_project_write_access(&transaction, &project, &owner_context(owner_user_id), None)
        .await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to validate a save permission: {error}"))
    })?;
    info!(
        project_id = %project_id,
        runtime_id = %runtime_id,
        origin_id = %origin_id,
        "a stop's save-only permission was exchanged for git access"
    );
    Ok(SaveGrantGitContext {
        owner_user_id,
        runtime_id,
        expires_at,
    })
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
    token: &str,
) -> PreStopFlushOutcome {
    let (origin_base, host_override) =
        resolve_origin_proxy_upstream_endpoint(&target.origin_endpoint);
    let mut request = state
        .origin_proxy_client
        .post(format!("{}/git/flush", origin_base.trim_end_matches('/')))
        .bearer_auth(token)
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
            writer = target.writer.label(),
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
            writer = target.writer.label(),
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
            writer = target.writer.label(),
            turn_active = target.turn_active,
            "nobody may save before the stop; the runtime keeps its work on local recovery refs"
        ),
        PreStopFlushOutcome::Failed(error) => warn!(
            runtime_id = %target.runtime_id,
            project_id = %target.project_id,
            origin_id = %target.origin_id,
            writer = target.writer.label(),
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
        "writer": target.writer.label(),
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
