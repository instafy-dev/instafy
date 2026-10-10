//! Draining a controller node before it is retired.
//!
//! Hosted runtimes run on the node of the controller that started them.
//! Canonical git holds their work (rolling saves while a turn runs, and each
//! stop's own flush), so the checkouts they leave on the node's disk are a
//! cache that the next start clones again. What must not run into a node's
//! deletion is a live runtime. Before a release retires the previous
//! controller pool, the release workflow asks that controller (directly,
//! with the service-role bearer) to drain its node:
//!
//! - `GET /operator/runtime-drain/census` lists the runtimes its node-local
//!   provider holds, joined with the database: `live` runtimes (the
//!   container runs the runtime's active lease generation) and `orphan`
//!   containers (any other generation);
//! - `POST /operator/runtime-drain/fence` stops this process from starting
//!   runtimes and from running its own stop sweeps, which after a cutover act
//!   through this node's provider on runtimes that may live elsewhere;
//! - `POST /operator/runtime-drain/stop` stops one live runtime through the
//!   safe stop, which flushes its workspace first (under the space owner's
//!   save-only permission when nobody holds a workspace lease), refusing any
//!   generation other than the one the caller names.
//!
//! Every route answers only the service role (never a user, an operator
//! session or a scoped token) and is recorded as a `pool_retirement_drain`
//! runtime event without tokens, paths or ref contents.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tracing::{info, warn};
use uuid::Uuid;

use crate::auth::authenticate_request;
use crate::config::RuntimeProviderConfig;
use crate::tunnels::revoke_tunnels_for_scope;
use crate::{bad_request, forbidden, internal_error, unauthorized, ApiError, AppState};

use super::db::record_runtime_event;
use super::pre_stop_flush::FlushSummary;
use super::provider::call_provider_endpoint_json;
use super::stop::{
    stop_runtime_safely, RuntimeIdentityExpectation, StopOptions, DRAIN_STOP_SOURCE,
};

/// The longest fence a caller may set; it lapses on its own after that.
const MAX_FENCE_SECONDS: u64 = 3600;
/// How long a census may wait for the node's provider.
const CENSUS_TIMEOUT: Duration = Duration::from_secs(30);
const DRAIN_EVENT: &str = "pool_retirement_drain";

/// This process's drain fence. Process-local on purpose: the controller
/// that serves the same database after a cutover is never fenced by it.
#[derive(Clone, Default)]
pub(crate) struct RuntimeDrainState {
    fenced_until: Arc<Mutex<Option<(Instant, DateTime<Utc>)>>>,
}

impl RuntimeDrainState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<(Instant, DateTime<Utc>)>> {
        self.fenced_until
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The fence is up: this process starts no runtime and runs no stop but
    /// the drain's.
    pub(crate) fn is_fenced(&self) -> bool {
        self.fenced_until().is_some()
    }

    fn fenced_until(&self) -> Option<DateTime<Utc>> {
        let mut fenced_until = self.lock();
        match *fenced_until {
            Some((until, at)) if Instant::now() < until => Some(at),
            Some(_) => {
                *fenced_until = None;
                None
            }
            None => None,
        }
    }

    fn set_fence(&self, ttl: Option<Duration>) -> Option<DateTime<Utc>> {
        let mut fenced_until = self.lock();
        *fenced_until = ttl.map(|ttl| {
            (
                Instant::now() + ttl,
                Utc::now() + chrono::Duration::from_std(ttl).unwrap_or_default(),
            )
        });
        fenced_until.map(|(_, at)| at)
    }
}

/// The error an ensure gets while this process is fenced.
pub(crate) fn controller_retiring() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ApiError::with_details(
            "this controller is being retired and starts no runtimes",
            "controller_retiring",
            json!({}),
        )),
    )
}

/// Only the service role: 401 without credentials, 403 for anyone else.
async fn require_service_role(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, headers).await?;
    if context.is_service_role && context.scoped_claims.is_none() {
        return Ok(());
    }
    if context.user_id.is_none() && context.scoped_claims.is_none() {
        return Err(unauthorized("service-role authorization required"));
    }
    Err(forbidden(
        "draining a controller requires the service-role bearer",
    ))
}

// ---------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------

/// One runtime on the node, as the provider sees it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProviderContainer {
    compose_project: String,
    project_id: Option<Uuid>,
    runtime_id: Option<Uuid>,
    lease_id: Option<Uuid>,
    running: bool,
}

/// The provider's census. Fields it adds (an older provider's checkout
/// list among them) are ignored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProviderCensus {
    supported: bool,
    containers: Vec<ProviderContainer>,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainProvider {
    provider: String,
    supported: bool,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainRuntime {
    provider: String,
    compose_project: String,
    project_id: Option<Uuid>,
    runtime_id: Option<Uuid>,
    /// The generation the containers run (from their environment).
    lease_id: Option<Uuid>,
    container_running: bool,
    db_status: Option<String>,
    db_active_lease_id: Option<Uuid>,
    db_lease_status: Option<String>,
    /// `live` (the runtime's active generation: drain it with `stop`) or
    /// `orphan` (any other).
    class: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainCensusResponse {
    fenced: bool,
    fenced_until: Option<DateTime<Utc>>,
    /// Every provider answered a complete census.
    complete: bool,
    providers: Vec<DrainProvider>,
    runtimes: Vec<DrainRuntime>,
}

/// The providers this node drains: every configured provider that launches
/// runtimes through an endpoint (never a self-hosted machine).
fn drained_providers(state: &AppState) -> Vec<RuntimeProviderConfig> {
    let mut providers: Vec<RuntimeProviderConfig> = state
        .provider_registry
        .provider_configs()
        .into_iter()
        .filter(|provider| {
            !crate::provider_identifiers::is_self_hosted_provider_kind(&provider.kind)
                && !crate::provider_identifiers::is_self_hosted_provider_id(&provider.id)
                && provider
                    .endpoint
                    .as_deref()
                    .is_some_and(|endpoint| !endpoint.trim().is_empty())
        })
        .collect();
    providers.sort_by(|a, b| a.id.cmp(&b.id));
    providers
}

async fn provider_census(
    state: &AppState,
    provider: &RuntimeProviderConfig,
) -> anyhow::Result<ProviderCensus> {
    let body = call_provider_endpoint_json(
        state,
        provider,
        "/runtime/census",
        &json!({}),
        CENSUS_TIMEOUT,
    )
    .await?
    .unwrap_or(JsonValue::Null);
    Ok(serde_json::from_value(body).unwrap_or_default())
}

#[derive(Debug, Clone)]
struct DbRuntime {
    project_id: Uuid,
    status: String,
    active_lease_id: Option<Uuid>,
    lease_status: Option<String>,
}

async fn load_db_runtimes(
    state: &AppState,
    runtime_ids: &[Uuid],
) -> Result<HashMap<Uuid, DbRuntime>, (StatusCode, Json<ApiError>)> {
    if runtime_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to read runtimes: {error}")))?;
    let rows = connection
        .query(
            "select r.id, r.project_id, r.status, r.active_lease_id, l.status as lease_status
             from runtimes r
             left join runtime_leases l on l.id = r.active_lease_id
             where r.id = any($1)",
            &[&runtime_ids],
        )
        .await
        .map_err(|error| internal_error(format!("failed to read runtimes: {error}")))?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                row.get("id"),
                DbRuntime {
                    project_id: row.get("project_id"),
                    status: row.get("status"),
                    active_lease_id: row.get("active_lease_id"),
                    lease_status: row.get("lease_status"),
                },
            )
        })
        .collect())
}

fn live_status(status: &str) -> bool {
    matches!(
        status,
        "requested" | "launching" | "ready" | "running" | "draining" | "leased"
    )
}

fn classify(container: &ProviderContainer, db: Option<&DbRuntime>) -> &'static str {
    match (container.runtime_id, container.lease_id, db) {
        (Some(_), Some(lease_id), Some(db))
            if container
                .project_id
                .is_none_or(|project| project == db.project_id)
                && db.active_lease_id == Some(lease_id)
                && live_status(&db.status)
                && db.lease_status.as_deref() != Some("released") =>
        {
            "live"
        }
        _ => "orphan",
    }
}

/// The node's census for one provider, joined with the database.
async fn census_for(
    state: &AppState,
    provider: &RuntimeProviderConfig,
) -> Result<(DrainProvider, Vec<DrainRuntime>), (StatusCode, Json<ApiError>)> {
    let census = match provider_census(state, provider).await {
        Ok(census) => census,
        Err(error) => {
            warn!(provider = %provider.id, %error, "runtime census failed");
            return Ok((
                DrainProvider {
                    provider: provider.id.clone(),
                    supported: false,
                    truncated: false,
                    error: Some("the provider did not answer the census".to_string()),
                },
                Vec::new(),
            ));
        }
    };
    let runtime_ids: Vec<Uuid> = census
        .containers
        .iter()
        .filter_map(|container| container.runtime_id)
        .collect();
    let db = load_db_runtimes(state, &runtime_ids).await?;
    let runtimes = census
        .containers
        .iter()
        .map(|container| {
            let row = container.runtime_id.and_then(|id| db.get(&id));
            DrainRuntime {
                provider: provider.id.clone(),
                compose_project: container.compose_project.clone(),
                project_id: container.project_id,
                runtime_id: container.runtime_id,
                lease_id: container.lease_id,
                container_running: container.running,
                db_status: row.map(|row| row.status.clone()),
                db_active_lease_id: row.and_then(|row| row.active_lease_id),
                db_lease_status: row.and_then(|row| row.lease_status.clone()),
                class: classify(container, row),
            }
        })
        .collect();
    Ok((
        DrainProvider {
            provider: provider.id.clone(),
            supported: census.supported,
            truncated: census.truncated,
            error: None,
        },
        runtimes,
    ))
}

pub(super) async fn drain_census(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DrainCensusResponse>, (StatusCode, Json<ApiError>)> {
    require_service_role(&state, &headers).await?;
    let mut response = DrainCensusResponse {
        fenced: false,
        fenced_until: state.runtime_drain.fenced_until(),
        complete: true,
        providers: Vec::new(),
        runtimes: Vec::new(),
    };
    response.fenced = response.fenced_until.is_some();
    for provider in drained_providers(&state) {
        let (summary, runtimes) = census_for(&state, &provider).await?;
        response.complete &= summary.supported && !summary.truncated && summary.error.is_none();
        response.providers.push(summary);
        response.runtimes.extend(runtimes);
    }
    Ok(Json(response))
}

// ---------------------------------------------------------------------
// Fence
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainFenceRequest {
    fenced: bool,
    ttl_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainFenceResponse {
    fenced: bool,
    expires_at: Option<DateTime<Utc>>,
}

pub(super) async fn drain_fence(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DrainFenceRequest>,
) -> Result<Json<DrainFenceResponse>, (StatusCode, Json<ApiError>)> {
    require_service_role(&state, &headers).await?;
    let expires_at = if request.fenced {
        let seconds = request.ttl_seconds.unwrap_or(1800);
        if seconds == 0 || seconds > MAX_FENCE_SECONDS {
            return Err(bad_request(format!(
                "ttlSeconds must be between 1 and {MAX_FENCE_SECONDS}"
            )));
        }
        state
            .runtime_drain
            .set_fence(Some(Duration::from_secs(seconds)))
    } else {
        state.runtime_drain.set_fence(None)
    };
    info!(
        fenced = request.fenced,
        ?expires_at,
        "runtime drain fence changed"
    );
    Ok(Json(DrainFenceResponse {
        fenced: expires_at.is_some(),
        expires_at,
    }))
}

// ---------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------

/// Fields a caller adds are ignored.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainStopRequest {
    runtime_id: Uuid,
    project_id: Uuid,
    /// The generation the node runs (the census's `leaseId`).
    lease_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainStopResponse {
    /// Always `true`: the stop ran. Kept for release tooling that still
    /// reads it.
    ok: bool,
    status_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    skip_reason: Option<String>,
    /// The stop's pre-stop flush: what is still only on the node
    /// (`unpushedRefs`) and, with rolling saves, whether canonical holds
    /// everything the working folder held (`workingState`).
    flush: FlushSummary,
}

async fn record_drain_event(state: &AppState, runtime_id: Uuid, project_id: Uuid, data: JsonValue) {
    let result =
        async {
            let mut connection =
                state.pool.get().await.map_err(|error| {
                    internal_error(format!("failed to get a connection: {error}"))
                })?;
            let transaction = connection.transaction().await.map_err(|error| {
                internal_error(format!("failed to start a transaction: {error}"))
            })?;
            record_runtime_event(&transaction, &runtime_id, &project_id, DRAIN_EVENT, data).await?;
            transaction
                .commit()
                .await
                .map_err(|error| internal_error(format!("failed to commit the event: {error}")))
        }
        .await;
    if let Err((_, body)) = result {
        warn!(%runtime_id, error = %body.0.message, "failed to record a drain event");
    }
}

/// Stop one runtime through the safe stop with the drain's source, refusing
/// any other generation than the request's `leaseId`.
pub(super) async fn drain_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DrainStopRequest>,
) -> Result<Json<DrainStopResponse>, (StatusCode, Json<ApiError>)> {
    require_service_role(&state, &headers).await?;
    let DrainStopRequest {
        runtime_id,
        project_id,
        lease_id,
    } = request;
    let stopped = stop_runtime_safely(
        &state,
        &runtime_id,
        StopOptions {
            source: DRAIN_STOP_SOURCE,
            reason: Some("pool_retirement".to_string()),
            // The node is going away: an active turn is interrupted, its
            // commits go to a recovery ref and its job is requeued.
            skip_if_active_jobs: false,
            require_idle_timeout: false,
            allow_cleanup_pending_release: false,
            expected_identity: Some(RuntimeIdentityExpectation {
                project_id: Some(project_id),
                provider: None,
                display_name: None,
                lease_id: Some(lease_id),
            }),
        },
    )
    .await?;
    if stopped.outcome.status_changed {
        if let Err((status, payload)) = revoke_tunnels_for_scope(
            &state,
            &stopped.runtime.project_id,
            Some(&stopped.runtime.id),
            stopped.outcome.released_runtime_lease_id.as_ref(),
            "pool_retirement",
        )
        .await
        {
            warn!(
                runtime_id = %runtime_id,
                %status,
                error = payload.0.message,
                "failed to revoke tunnels after a drain stop"
            );
        }
    }
    record_drain_event(
        &state,
        runtime_id,
        project_id,
        json!({
            "action": DRAIN_STOP_SOURCE,
            "runtimeLeaseId": lease_id,
            "statusChanged": stopped.outcome.status_changed,
            "skipReason": stopped.outcome.skip_reason,
            "flushStatus": stopped.flush.status,
            "unpushedRefs": stopped.flush.unpushed_refs,
        }),
    )
    .await;
    Ok(Json(DrainStopResponse {
        ok: true,
        status_changed: stopped.outcome.status_changed,
        skip_reason: stopped.outcome.skip_reason,
        flush: stopped.flush,
    }))
}

/// Tests read the classification without a node.
#[cfg(test)]
pub(super) fn classify_for_test(
    runtime_id: Option<Uuid>,
    lease_id: Option<Uuid>,
    db_status: &str,
    db_active_lease_id: Option<Uuid>,
    db_lease_status: Option<&str>,
) -> &'static str {
    let project = Uuid::new_v4();
    classify(
        &ProviderContainer {
            compose_project: String::new(),
            project_id: Some(project),
            runtime_id,
            lease_id,
            running: true,
        },
        Some(&DbRuntime {
            project_id: project,
            status: db_status.to_string(),
            active_lease_id: db_active_lease_id,
            lease_status: db_lease_status.map(str::to_string),
        }),
    )
}

#[cfg(test)]
#[path = "drain_tests.rs"]
mod db_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_runtimes_active_generation_is_live() {
        let runtime = Some(Uuid::new_v4());
        let lease = Uuid::new_v4();
        assert_eq!(
            classify_for_test(runtime, Some(lease), "ready", Some(lease), Some("active")),
            "live"
        );
        for (status, active, lease_status) in [
            ("ready", Some(Uuid::new_v4()), Some("active")),
            ("stopped", None, None),
            ("ready", Some(lease), Some("released")),
        ] {
            assert_eq!(
                classify_for_test(runtime, Some(lease), status, active, lease_status),
                "orphan",
                "{status} {active:?} {lease_status:?}"
            );
        }
        assert_eq!(
            classify_for_test(runtime, None, "ready", Some(lease), Some("active")),
            "orphan"
        );
    }

    /// An older provider's census still lists checkouts, and the controller
    /// ignores the list. That provider's `truncated` flag can still reflect
    /// a cut or unreadable checkout listing, which only holds the node.
    #[test]
    fn a_provider_census_reads_containers_only() {
        let census: ProviderCensus = serde_json::from_value(json!({
            "supported": true,
            "truncated": false,
            "containers": [{ "composeProject": "instafy-runtime-x", "running": true }],
            "checkouts": [{ "projectId": Uuid::new_v4(), "unpushedRefs": 3 }],
        }))
        .expect("census");
        assert!(census.supported && !census.truncated);
        assert_eq!(census.containers.len(), 1);
    }

    #[test]
    fn the_fence_lapses_and_lifts() {
        let drain = RuntimeDrainState::default();
        assert!(!drain.is_fenced());
        drain.set_fence(Some(Duration::from_secs(60)));
        assert!(drain.is_fenced());
        drain.set_fence(None);
        assert!(!drain.is_fenced());
        drain.set_fence(Some(Duration::from_millis(1)));
        std::thread::sleep(Duration::from_millis(5));
        assert!(!drain.is_fenced(), "a fence lapses on its own");
    }
}
