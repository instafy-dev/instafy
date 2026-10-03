//! Draining a controller node before it is retired.
//!
//! Hosted runtimes run on the node of the controller that started them, and
//! their workspace checkouts live on that node's disk. Deleting the node
//! deletes both, including work that is only on a checkout's local recovery
//! refs. Before a release retires the previous controller pool, the release
//! workflow asks that controller (directly, with the service-role bearer) to
//! drain its node:
//!
//! - `GET /operator/runtime-drain/census` lists the runtimes and checkouts
//!   its node-local provider holds, joined with the database: `live` runtimes
//!   (the container runs the runtime's active lease generation), `orphan`
//!   containers (any other generation), and checkouts that `needsFlush`
//!   (no running container, and unpushed local refs, no clean stop, or
//!   unreadable);
//! - `POST /operator/runtime-drain/fence` stops this process from starting
//!   runtimes and from running its own stop sweeps, which after a cutover act
//!   through this node's provider on runtimes that may live elsewhere;
//! - `POST /operator/runtime-drain/stop` stops one live runtime through the
//!   safe stop, which flushes its workspace first (under the space owner's
//!   save-only permission when nobody holds a workspace lease), refusing any
//!   generation other than the one the caller names;
//! - `POST /operator/runtime-drain/flush-checkout` saves a stopped checkout:
//!   it releases orphans, starts the space's runtime on this node without
//!   handing it jobs or billing it, and stops it again through the same
//!   flush.
//!
//! Every route answers only the service role (never a user, an operator
//! session or a scoped token) and is recorded as a `pool_retirement_drain`
//! runtime event without tokens, paths or ref contents.

use std::collections::{HashMap, HashSet};
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

use super::db::{fetch_runtime_for_update, record_runtime_event, RuntimeDetails};
use super::pre_stop_flush::FlushSummary;
use super::provider::{
    call_provider_endpoint, call_provider_endpoint_json,
    lock_and_load_authoritative_provider_config, ProviderReleaseRequest,
    RUNTIME_PROVIDER_RELEASE_TIMEOUT,
};
use super::stop::{stop_runtime_safely, RuntimeIdentityExpectation, StopOptions};

/// The longest fence a caller may set; it lapses on its own after that.
const MAX_FENCE_SECONDS: u64 = 3600;
/// How long a census may wait for the node's provider.
const CENSUS_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a woken runtime may take to bring its origin online.
#[cfg(not(test))]
const WAKE_ORIGIN_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(test)]
const WAKE_ORIGIN_TIMEOUT: Duration = Duration::from_secs(3);
const WAKE_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// The kind of the runtime event that marks a drain's wake generation; the
/// hosted runtime credit sweep never bills that generation.
pub(crate) const FLUSH_WAKE_EVENT: &str = "pool_retirement_flush_wake";
const DRAIN_EVENT: &str = "pool_retirement_drain";

/// This process's drain state: the fence, and the runtimes it has woken
/// only to flush their checkout. Process-local on purpose: the controller
/// that serves the same database after a cutover is never fenced by it.
#[derive(Clone, Default)]
pub(crate) struct RuntimeDrainState {
    inner: Arc<Mutex<DrainInner>>,
}

#[derive(Default)]
struct DrainInner {
    fenced_until: Option<(Instant, DateTime<Utc>)>,
    flush_wakes: HashSet<Uuid>,
}

impl RuntimeDrainState {
    fn lock(&self) -> std::sync::MutexGuard<'_, DrainInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The fence is up: this process starts no runtime (except a drain's own
    /// wake) and runs no stop but the drain's.
    pub(crate) fn is_fenced(&self) -> bool {
        self.fenced_until().is_some()
    }

    fn fenced_until(&self) -> Option<DateTime<Utc>> {
        let mut inner = self.lock();
        match inner.fenced_until {
            Some((until, at)) if Instant::now() < until => Some(at),
            Some(_) => {
                inner.fenced_until = None;
                None
            }
            None => None,
        }
    }

    fn set_fence(&self, ttl: Option<Duration>) -> Option<DateTime<Utc>> {
        let mut inner = self.lock();
        inner.fenced_until = ttl.map(|ttl| {
            (
                Instant::now() + ttl,
                Utc::now() + chrono::Duration::from_std(ttl).unwrap_or_default(),
            )
        });
        inner.fenced_until.map(|(_, at)| at)
    }

    /// The runtime was started by a drain only to flush its checkout: it
    /// may start while fenced, and leases no job.
    pub(crate) fn is_flush_wake(&self, runtime_id: &Uuid) -> bool {
        self.lock().flush_wakes.contains(runtime_id)
    }

    fn begin_flush_wake(&self, runtime_id: Uuid) -> Option<FlushWakeGuard> {
        self.lock()
            .flush_wakes
            .insert(runtime_id)
            .then(|| FlushWakeGuard {
                state: self.clone(),
                runtime_id,
            })
    }
}

/// Ends a flush wake when dropped, whatever happened.
struct FlushWakeGuard {
    state: RuntimeDrainState,
    runtime_id: Uuid,
}

impl Drop for FlushWakeGuard {
    fn drop(&mut self) {
        self.state.lock().flush_wakes.remove(&self.runtime_id);
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

/// One checkout on the node's disk, as the provider sees it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProviderCheckout {
    project_id: Option<Uuid>,
    runtime_present: bool,
    stopped_cleanly: bool,
    unpushed_refs: usize,
    unpushed_ref_names: Vec<String>,
    unreadable: Option<String>,
    empty: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProviderCensus {
    supported: bool,
    containers: Vec<ProviderContainer>,
    checkouts: Vec<ProviderCheckout>,
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
    /// `orphan` (any other: `flush-checkout` releases it).
    class: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainCheckout {
    provider: String,
    project_id: Uuid,
    /// The space's newest runtime on this provider, if it has one.
    runtime_id: Option<Uuid>,
    runtime_present: bool,
    stopped_cleanly: bool,
    unpushed_refs: usize,
    unpushed_ref_names: Vec<String>,
    unreadable: Option<String>,
    empty: bool,
    /// Deleting the node now could lose work, and no running runtime of the
    /// space is here to flush it: unpushed refs, no clean stop, or refs that
    /// cannot be read. A stopped container does not count as running.
    needs_flush: bool,
}

impl DrainCheckout {
    /// Nothing on this checkout exists only here, and no runtime uses it.
    fn is_clean(&self) -> bool {
        !self.runtime_present && self.holds_nothing_only_here()
    }

    fn holds_nothing_only_here(&self) -> bool {
        self.empty || (self.stopped_cleanly && self.unpushed_refs == 0 && self.unreadable.is_none())
    }
}

/// What a census says about one space's checkout.
#[derive(Debug)]
enum CheckoutLookup {
    Listed(DrainCheckout),
    /// A complete census that does not list it: nothing of it is here.
    NotListed,
    /// The census failed, cannot list the node or was cut short: unknown.
    Unknown(&'static str),
}

impl CheckoutLookup {
    /// `Some(true)` when nothing of the space is only here.
    fn is_clean(&self) -> Option<bool> {
        match self {
            Self::Listed(checkout) => Some(checkout.is_clean()),
            Self::NotListed => Some(true),
            Self::Unknown(_) => None,
        }
    }

    fn into_checkout(self) -> Option<DrainCheckout> {
        match self {
            Self::Listed(checkout) => Some(checkout),
            _ => None,
        }
    }

    fn error(&self) -> Option<&'static str> {
        match self {
            Self::Unknown(error) => Some(error),
            _ => None,
        }
    }
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
    checkouts: Vec<DrainCheckout>,
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

/// The provider's authoritative route, as a release resolves it.
async fn resolve_provider(
    state: &AppState,
    provider_id: &str,
) -> Result<RuntimeProviderConfig, (StatusCode, Json<ApiError>)> {
    let fallback = state.provider_registry.provider_config(provider_id);
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to resolve the provider: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to resolve the provider: {error}")))?;
    let provider =
        lock_and_load_authoritative_provider_config(&transaction, provider_id, fallback.as_ref())
            .await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to resolve the provider: {error}")))?;
    provider.ok_or_else(|| bad_request(format!("provider '{provider_id}' is not configured")))
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

/// Each space's newest runtime on `provider`.
async fn newest_runtimes(
    state: &AppState,
    provider: &str,
    project_ids: &[Uuid],
) -> Result<HashMap<Uuid, Uuid>, (StatusCode, Json<ApiError>)> {
    if project_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to read runtimes: {error}")))?;
    let rows = connection
        .query(
            "select distinct on (project_id) project_id, id
             from runtimes
             where project_id = any($1)
               and lower(replace(btrim(provider), '_', '-')) =
                   lower(replace(btrim($2::text), '_', '-'))
             order by project_id, updated_at desc",
            &[&project_ids, &provider],
        )
        .await
        .map_err(|error| internal_error(format!("failed to read runtimes: {error}")))?;
    Ok(rows
        .iter()
        .map(|row| (row.get("project_id"), row.get("id")))
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

/// The spaces with a running container in `census`.
fn running_projects(census: &ProviderCensus) -> HashSet<Uuid> {
    census
        .containers
        .iter()
        .filter(|container| container.running)
        .filter_map(|container| container.project_id)
        .collect()
}

fn drain_checkout(
    provider: &str,
    checkout: &ProviderCheckout,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    runtime_running: bool,
) -> DrainCheckout {
    let mut entry = DrainCheckout {
        provider: provider.to_string(),
        project_id,
        runtime_id,
        runtime_present: checkout.runtime_present,
        stopped_cleanly: checkout.stopped_cleanly,
        unpushed_refs: checkout.unpushed_refs,
        unpushed_ref_names: checkout.unpushed_ref_names.clone(),
        unreadable: checkout.unreadable.clone(),
        empty: checkout.empty,
        needs_flush: false,
    };
    entry.needs_flush = !runtime_running && !entry.holds_nothing_only_here();
    entry
}

/// The node's census for one provider, joined with the database.
async fn census_for(
    state: &AppState,
    provider: &RuntimeProviderConfig,
) -> Result<(DrainProvider, Vec<DrainRuntime>, Vec<DrainCheckout>), (StatusCode, Json<ApiError>)> {
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
    let project_ids: Vec<Uuid> = census
        .checkouts
        .iter()
        .filter_map(|checkout| checkout.project_id)
        .collect();
    let newest = newest_runtimes(state, &provider.id, &project_ids).await?;
    let running = running_projects(&census);
    let checkouts = census
        .checkouts
        .iter()
        .filter_map(|checkout| {
            let project_id = checkout.project_id?;
            Some(drain_checkout(
                &provider.id,
                checkout,
                project_id,
                newest.get(&project_id).copied(),
                running.contains(&project_id),
            ))
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
        checkouts,
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
        checkouts: Vec::new(),
    };
    response.fenced = response.fenced_until.is_some();
    for provider in drained_providers(&state) {
        let (summary, runtimes, checkouts) = census_for(&state, &provider).await?;
        response.complete &= summary.supported && !summary.truncated && summary.error.is_none();
        response.providers.push(summary);
        response.runtimes.extend(runtimes);
        response.checkouts.extend(checkouts);
    }
    Ok(Json(response))
}

/// The checkout of `project_id` on `provider`'s node, from a fresh census.
/// Absent only when a complete census does not list it: a census that
/// failed, cannot list the node or was cut short says nothing.
async fn checkout_of(
    state: &AppState,
    provider: &RuntimeProviderConfig,
    project_id: Uuid,
) -> CheckoutLookup {
    let census = match provider_census(state, provider).await {
        Ok(census) => census,
        Err(error) => {
            warn!(provider = %provider.id, %project_id, %error, "runtime census failed");
            return CheckoutLookup::Unknown("the provider did not answer the census");
        }
    };
    let Some(checkout) = census
        .checkouts
        .iter()
        .find(|checkout| checkout.project_id == Some(project_id))
    else {
        return if !census.supported {
            CheckoutLookup::Unknown("the provider cannot list its node")
        } else if census.truncated {
            CheckoutLookup::Unknown("the provider's census was cut short")
        } else {
            CheckoutLookup::NotListed
        };
    };
    let runtime_id = newest_runtimes(state, &provider.id, &[project_id])
        .await
        .ok()
        .and_then(|newest| newest.get(&project_id).copied());
    CheckoutLookup::Listed(drain_checkout(
        &provider.id,
        checkout,
        project_id,
        runtime_id,
        running_projects(&census).contains(&project_id),
    ))
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
    /// The stop ran and its census answered: `false` when the checkout's
    /// state after the stop is unknown (`checkoutError`).
    ok: bool,
    status_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    skip_reason: Option<String>,
    flush: FlushSummary,
    /// The space's checkout on this node after the stop, when the census
    /// lists it; `null` with no `checkoutError` when a complete census does
    /// not.
    checkout: Option<DrainCheckout>,
    /// Why the checkout's state after the stop is unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    checkout_error: Option<&'static str>,
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
/// any other generation than `lease_id`. Returns the stop's response.
async fn drain_stop_runtime(
    state: &AppState,
    runtime_id: Uuid,
    project_id: Uuid,
    lease_id: Uuid,
    source: &'static str,
) -> Result<DrainStopResponse, (StatusCode, Json<ApiError>)> {
    let stopped = stop_runtime_safely(
        state,
        &runtime_id,
        StopOptions {
            source,
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
            state,
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
    let checkout = match resolve_provider(state, &stopped.runtime.provider).await {
        Ok(provider) => checkout_of(state, &provider, project_id).await,
        Err(_) => CheckoutLookup::Unknown("the runtime's provider is not configured here"),
    };
    let mut flush = stopped.flush;
    if flush.status == "not_running" {
        // Nothing live to flush: what the checkout still holds is the answer.
        match &checkout {
            CheckoutLookup::Listed(listed) => {
                flush.unpushed_refs = Some(listed.unpushed_refs);
                flush.unpushed_ref_names = listed.unpushed_ref_names.clone();
            }
            CheckoutLookup::NotListed => flush.unpushed_refs = Some(0),
            CheckoutLookup::Unknown(_) => {}
        }
    }
    let checkout_error = checkout.error();
    record_drain_event(
        state,
        runtime_id,
        project_id,
        json!({
            "action": source,
            "runtimeLeaseId": lease_id,
            "statusChanged": stopped.outcome.status_changed,
            "skipReason": stopped.outcome.skip_reason,
            "flushStatus": flush.status,
            "unpushedRefs": flush.unpushed_refs,
            "checkoutKnown": checkout_error.is_none(),
        }),
    )
    .await;
    Ok(DrainStopResponse {
        ok: checkout_error.is_none(),
        status_changed: stopped.outcome.status_changed,
        skip_reason: stopped.outcome.skip_reason,
        flush,
        checkout: checkout.into_checkout(),
        checkout_error,
    })
}

pub(super) async fn drain_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DrainStopRequest>,
) -> Result<Json<DrainStopResponse>, (StatusCode, Json<ApiError>)> {
    require_service_role(&state, &headers).await?;
    let response = drain_stop_runtime(
        &state,
        request.runtime_id,
        request.project_id,
        request.lease_id,
        "pool_retirement_drain",
    )
    .await?;
    Ok(Json(response))
}

// ---------------------------------------------------------------------
// Flush a stopped checkout
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainFlushCheckoutRequest {
    project_id: Uuid,
    /// The provider whose node holds the checkout; the only drained provider
    /// when omitted.
    provider: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DrainFlushCheckoutResponse {
    /// `clean` (nothing left only here), `flushed` (woken, flushed and
    /// clean), `busy_here` (a live runtime: use `stop`), `busy_elsewhere`
    /// (the space's runtime runs on another node), `no_runtime` (no runtime
    /// row to wake), `wake_failed`, or `failed` (still not clean, or the
    /// census could not say: then `error` says why).
    status: &'static str,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    /// Containers of other generations released first (compose projects).
    released_orphans: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    flush: Option<FlushSummary>,
    checkout: Option<DrainCheckout>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl DrainFlushCheckoutResponse {
    fn new(project_id: Uuid, runtime_id: Option<Uuid>) -> Self {
        Self {
            status: "failed",
            project_id,
            runtime_id,
            released_orphans: Vec::new(),
            flush: None,
            checkout: None,
            error: None,
        }
    }
}

fn pick_provider(
    state: &AppState,
    requested: Option<&str>,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    if let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(requested.to_string());
    }
    let providers = drained_providers(state);
    match providers.as_slice() {
        [only] => Ok(only.id.clone()),
        [] => Err(bad_request("no runtime provider is configured here")),
        _ => Err(bad_request(
            "several runtime providers are configured here; name one",
        )),
    }
}

async fn load_runtime(
    state: &AppState,
    runtime_id: &Uuid,
) -> Result<RuntimeDetails, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to read the runtime: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to read the runtime: {error}")))?;
    let runtime = fetch_runtime_for_update(&transaction, runtime_id).await?;
    transaction.rollback().await.ok();
    Ok(runtime)
}

/// Wait for the woken generation's hosted origin to come online. Returns
/// whether it did.
async fn wait_for_origin(state: &AppState, runtime: &RuntimeDetails, lease_id: Uuid) -> bool {
    let deadline = Instant::now() + WAKE_ORIGIN_TIMEOUT;
    loop {
        let online = async {
            let connection = state.pool.get().await.ok()?;
            let row = connection
                .query_one(
                    "select exists(
                        select 1
                        from origin_instances oi
                        join runtimes r on r.id = oi.runtime_id
                        where oi.project_id = $1
                          and oi.runtime_id = $2
                          and oi.lease_id = $3
                          and oi.status = 'online'
                          and oi.mode in ('hosted', 'efs')
                          and r.active_lease_id = $3
                          and r.status in ('ready', 'running', 'draining')
                     )",
                    &[&runtime.project_id, &runtime.id, &lease_id],
                )
                .await
                .ok()?;
            Some(row.get::<_, bool>(0))
        }
        .await
        .unwrap_or(false);
        if online {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(WAKE_POLL_INTERVAL).await;
    }
}

pub(super) async fn drain_flush_checkout(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DrainFlushCheckoutRequest>,
) -> Result<Json<DrainFlushCheckoutResponse>, (StatusCode, Json<ApiError>)> {
    require_service_role(&state, &headers).await?;
    let provider_id = pick_provider(&state, request.provider.as_deref())?;
    let provider = resolve_provider(&state, &provider_id).await?;
    let project_id = request.project_id;
    let census = provider_census(&state, &provider).await.map_err(|error| {
        warn!(provider = %provider.id, %error, "runtime census failed");
        (
            StatusCode::BAD_GATEWAY,
            Json(ApiError::new("the provider did not answer the census")),
        )
    })?;
    if !census.supported {
        return Err(bad_request("this provider cannot list its node"));
    }
    let runtime_id = newest_runtimes(&state, &provider.id, &[project_id])
        .await?
        .get(&project_id)
        .copied();
    let mut response = DrainFlushCheckoutResponse::new(project_id, runtime_id);
    let runtime = match runtime_id {
        Some(runtime_id) => Some(load_runtime(&state, &runtime_id).await?),
        None => None,
    };

    // Containers of this space on this node: the live generation is the
    // `stop` route's; any other generation is released here, with its own
    // ids, so its shutdown flush keeps its work on the checkout.
    let containers: Vec<&ProviderContainer> = census
        .containers
        .iter()
        .filter(|container| container.project_id == Some(project_id))
        .collect();
    for container in containers {
        let live = runtime.as_ref().is_some_and(|runtime| {
            container.runtime_id == Some(runtime.id)
                && container.lease_id.is_some()
                && container.lease_id == runtime.active_lease_id
                && live_status(&runtime.status)
        });
        if live {
            response.status = "busy_here";
            response.checkout = checkout_of(&state, &provider, project_id)
                .await
                .into_checkout();
            return Ok(Json(response));
        }
        let (Some(orphan_runtime), Some(orphan_lease)) = (container.runtime_id, container.lease_id)
        else {
            response.error = Some(format!(
                "a container without a runtime generation is left on the node: {}",
                container.compose_project
            ));
            response.checkout = checkout_of(&state, &provider, project_id)
                .await
                .into_checkout();
            return Ok(Json(response));
        };
        if let Err(error) = call_provider_endpoint(
            &state,
            &provider,
            "/runtime/release",
            &ProviderReleaseRequest {
                project_id: &project_id,
                runtime_id: &orphan_runtime,
                lease_id: Some(&orphan_lease),
            },
            RUNTIME_PROVIDER_RELEASE_TIMEOUT,
        )
        .await
        {
            warn!(%project_id, runtime_id = %orphan_runtime, %error, "could not release an orphan runtime");
            response.error = Some("an orphan runtime could not be released".to_string());
            response.checkout = checkout_of(&state, &provider, project_id)
                .await
                .into_checkout();
            return Ok(Json(response));
        }
        record_drain_event(
            &state,
            orphan_runtime,
            project_id,
            json!({ "action": "release_orphan", "runtimeLeaseId": orphan_lease }),
        )
        .await;
        response
            .released_orphans
            .push(container.compose_project.clone());
    }

    let lookup = checkout_of(&state, &provider, project_id).await;
    match lookup.is_clean() {
        None => {
            // A census that cannot say is never read as clean.
            response.error = lookup.error().map(str::to_string);
            return Ok(Json(response));
        }
        Some(true) => {
            response.status = "clean";
            response.checkout = lookup.into_checkout();
            return Ok(Json(response));
        }
        Some(false) => {}
    }
    let checkout = lookup.into_checkout();
    let Some(runtime) = runtime else {
        response.status = "no_runtime";
        response.checkout = checkout;
        return Ok(Json(response));
    };
    if runtime.active_lease_id.is_some() && live_status(&runtime.status) {
        // Its active generation is not on this node.
        response.status = "busy_elsewhere";
        response.checkout = checkout;
        return Ok(Json(response));
    }

    // Wake the space's runtime on this node: it mounts the same checkout,
    // leases no job, is not billed, and is stopped again at once through
    // the flush.
    let Some(_wake) = state.runtime_drain.begin_flush_wake(runtime.id) else {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new("this checkout is already being flushed")),
        ));
    };
    // Marked before the launch exists, so no sweep bills it while it starts.
    record_wake(&state, &runtime, json!({ "phase": "starting" })).await;
    let woken = match super::ensure::ensure_runtime_for_drain_flush(&state, &runtime).await {
        Ok(woken) => woken,
        Err((status, body)) => {
            warn!(%project_id, runtime_id = %runtime.id, %status, error = %body.0.message, "could not wake a runtime to flush its checkout");
            response.status = "wake_failed";
            response.error = Some(body.0.message);
            response.checkout = checkout;
            return Ok(Json(response));
        }
    };
    let Ok(lease_id) = Uuid::parse_str(&woken.lease_id) else {
        response.status = "wake_failed";
        response.error = Some("the woken runtime has no lease generation".to_string());
        return Ok(Json(response));
    };
    record_wake(
        &state,
        &runtime,
        json!({ "phase": "started", "runtimeLeaseId": lease_id }),
    )
    .await;
    let online = wait_for_origin(&state, &runtime, lease_id).await;
    if !online {
        warn!(%project_id, runtime_id = %runtime.id, "a woken runtime's origin did not come online; stopping it");
    }
    let stopped = drain_stop_runtime(
        &state,
        runtime.id,
        project_id,
        lease_id,
        "pool_retirement_flush",
    )
    .await;
    let after = checkout_of(&state, &provider, project_id).await;
    match stopped {
        Ok(stopped) => {
            response.flush = Some(stopped.flush);
            response.status = match (online, after.is_clean()) {
                (false, _) => "wake_failed",
                (true, Some(true)) => "flushed",
                (true, _) => "failed",
            };
            if let Some(error) = after.error() {
                response.error = Some(error.to_string());
            }
        }
        Err((_, body)) => {
            response.status = "failed";
            response.error = Some(body.0.message);
        }
    }
    response.checkout = after.into_checkout();
    Ok(Json(response))
}

/// Mark the woken generation, so no controller bills it: `starting` before
/// its launch (the hosted runtime credit sweep skips a generation requested
/// within three minutes after it), `started` with its lease once it exists.
async fn record_wake(state: &AppState, runtime: &RuntimeDetails, data: JsonValue) {
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
                &runtime.id,
                &runtime.project_id,
                FLUSH_WAKE_EVENT,
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
        warn!(runtime_id = %runtime.id, error = %body.0.message, "failed to mark a drain wake");
    }
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

    #[test]
    fn a_checkout_needs_a_flush_unless_nothing_on_it_is_only_here() {
        let base = ProviderCheckout {
            project_id: Some(Uuid::new_v4()),
            runtime_present: false,
            stopped_cleanly: true,
            unpushed_refs: 0,
            unpushed_ref_names: Vec::new(),
            unreadable: None,
            empty: false,
        };
        let project = base.project_id.unwrap();
        assert!(!drain_checkout("p", &base, project, None, false).needs_flush);
        for checkout in [
            ProviderCheckout {
                unpushed_refs: 1,
                ..base.clone()
            },
            ProviderCheckout {
                stopped_cleanly: false,
                ..base.clone()
            },
            ProviderCheckout {
                unreadable: Some("no canonical repository".to_string()),
                ..base.clone()
            },
        ] {
            assert!(drain_checkout("p", &checkout, project, None, false).needs_flush);
            assert!(
                drain_checkout(
                    "p",
                    &ProviderCheckout {
                        runtime_present: true,
                        ..checkout.clone()
                    },
                    project,
                    None,
                    false
                )
                .needs_flush,
                "a stopped container flushes nothing"
            );
            assert!(
                !drain_checkout(
                    "p",
                    &ProviderCheckout {
                        runtime_present: true,
                        ..checkout.clone()
                    },
                    project,
                    None,
                    true
                )
                .needs_flush,
                "a running runtime is the stop route's to drain"
            );
        }
        let empty = ProviderCheckout {
            stopped_cleanly: false,
            unreadable: None,
            empty: true,
            ..base.clone()
        };
        assert!(!drain_checkout("p", &empty, project, None, false).needs_flush);
        let running = ProviderCheckout {
            runtime_present: true,
            stopped_cleanly: false,
            ..base
        };
        assert!(
            !drain_checkout("p", &running, project, None, true).needs_flush,
            "a checkout with a running runtime is the runtime's to drain"
        );
        assert!(!drain_checkout("p", &running, project, None, true).is_clean());
    }

    #[test]
    fn the_fence_lapses_and_flush_wakes_end_with_their_guard() {
        let drain = RuntimeDrainState::default();
        assert!(!drain.is_fenced());
        drain.set_fence(Some(Duration::from_secs(60)));
        assert!(drain.is_fenced());
        drain.set_fence(None);
        assert!(!drain.is_fenced());
        drain.set_fence(Some(Duration::from_millis(1)));
        std::thread::sleep(Duration::from_millis(5));
        assert!(!drain.is_fenced(), "a fence lapses on its own");

        let runtime = Uuid::new_v4();
        let wake = drain.begin_flush_wake(runtime).expect("first wake");
        assert!(drain.is_flush_wake(&runtime));
        assert!(
            drain.begin_flush_wake(runtime).is_none(),
            "one wake at a time"
        );
        drop(wake);
        assert!(!drain.is_flush_wake(&runtime));
    }
}
