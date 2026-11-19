//! A person's own private self-hosted machines across every space
//! (`GET /me/runtimes`), and revoking them (`POST /me/runtimes/revoke`).
//!
//! The list holds what a person would want to end: each runtime the
//! controller attested as theirs in a space that is not deleted (a `removed`
//! one only while a token it was issued may still be alive), and each runtime
//! token they minted for a new machine that has neither registered nor
//! expired yet (a pending mint). A space's name is shown only while they can
//! still read the space. A runtime belongs to one space, so a computer used in
//! several spaces is listed once per space.
//!
//! Revoking ([`super::revocation::end_machines_of_their_owner`]) gives each
//! selected runtime of theirs a new token generation, whatever its status and
//! whichever space it is in, spaces they left included, and deletes each
//! selected pending mint. Each such runtime's runtime, agent and job tokens
//! are then refused at their next use, and only a fresh mint starts it again.
//! The same computer's runtimes in other spaces keep working unless they are
//! selected too. The list shows a revoked runtime as revoked, with the time,
//! until its generation changes again (a fresh mint, a person's Stop or
//! removal, a membership fence), and until then a revocation skips it.
//!
//! A revoked runtime that was still running is then stopped as a person's
//! Stop stops it (`user_stop`): its jobs are requeued and its tunnels revoked
//! now rather than when its heartbeat lapses, and `runtime.stopped` and the
//! `run.progress` of each turn it interrupted are published.
//!
//! Neither touches the person's sign-in: a machine that still holds it can
//! mint itself a new token. Signing out everywhere
//! (`crate::sign_out_everywhere`) revokes them all and ends those sign-ins.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tracing::warn;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session};
use crate::projects::{load_project_record, user_may_read_project};
use crate::{bad_request, internal_error, ApiError, AppState};

use super::access::{runtime_is_private_self_hosted, self_hosted_owner_user_id};
use super::revocation::{
    attested_owner_is, end_machines_of_their_owner, generation_token_lifetime_bound,
    owner_revoked_at, EndedRuntime, OwnMachines,
};

/// The most ids one revocation names. A person with more revokes them all.
const MAX_REVOKED_IDS: usize = 100;

/// The status a pending mint is listed with: a machine token was minted, and
/// no machine has registered with it yet.
const PENDING_STATUS: &str = "pending";

/// What a machine that was still running is stopped with: the reason of a
/// person's Stop, so its queued turns are held as Stop holds them.
const REVOKED_STOP_REASON: &str = "user_stop";

/// The source of that stop, in its `runtime.stopped`.
const REVOKED_STOP_SOURCE: &str = "me_runtimes_revoke";

/// One of a person's own machines.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MyRuntime {
    pub(crate) runtime_id: Uuid,
    pub(crate) project_id: Uuid,
    /// Whether the person can still read the space.
    pub(crate) project_readable: bool,
    /// The space's name, while the person can still read the space.
    pub(crate) project_name: Option<String>,
    pub(crate) display_name: Option<String>,
    /// `None` for a pending mint, which names no provider.
    pub(crate) provider: Option<String>,
    /// The runtime's status, or `pending` for a pending mint.
    pub(crate) status: String,
    pub(crate) last_seen_at: Option<DateTime<Utc>>,
    /// When a pending mint was made; `None` for a runtime.
    pub(crate) minted_at: Option<DateTime<Utc>>,
    pub(crate) personal_browser: bool,
    /// Whether the person's revocation ended the runtime's tokens and nothing
    /// has given it a new generation since. Never for a pending mint, which a
    /// revocation deletes.
    pub(crate) revoked: bool,
    /// When that revocation was made, while `revoked`; otherwise `None`.
    pub(crate) revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MyRuntimesResponse {
    pub(crate) runtimes: Vec<MyRuntime>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RevokeMyRuntimesPayload {
    #[serde(default)]
    runtime_ids: Option<Vec<String>>,
    #[serde(default)]
    all: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevokeMyRuntimesResponse {
    /// The runtimes whose tokens this revocation ended. A runtime an earlier
    /// revocation ended, and nothing gave a new generation since, is not
    /// ended again or listed.
    revoked: Vec<Uuid>,
    /// The pending mints that can no longer register.
    pending_ended: Vec<Uuid>,
}

/// `GET /me/runtimes`: the signed-in person's own private self-hosted
/// machines, most recently seen first, then their pending mints, newest
/// first. Only their own sign-in may ask.
pub(crate) async fn list_my_runtimes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MyRuntimesResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let person = require_user_session(&context)?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let mut runtimes = machines_of(&state, &*connection, person).await?;

    // A space's name only while the person can still read it.
    let mut readable: HashMap<Uuid, bool> = HashMap::new();
    for runtime in &mut runtimes {
        let may_read = match readable.get(&runtime.project_id) {
            Some(may_read) => *may_read,
            None => {
                let may_read = match load_project_record(&*connection, &runtime.project_id).await {
                    Ok(project) => user_may_read_project(&*connection, &project, person)
                        .await
                        .unwrap_or(false),
                    Err(_) => false,
                };
                readable.insert(runtime.project_id, may_read);
                may_read
            }
        };
        runtime.project_readable = may_read;
        if !may_read {
            runtime.project_name = None;
        }
    }
    Ok(Json(MyRuntimesResponse { runtimes }))
}

/// `owner`'s machines as [`list_my_runtimes`] lists them, every space named.
async fn machines_of(
    state: &AppState,
    client: &impl tokio_postgres::GenericClient,
    owner: Uuid,
) -> Result<Vec<MyRuntime>, (StatusCode, Json<ApiError>)> {
    // Every space at once, so no index narrows it; a person asks for it.
    let query = format!(
        "select r.id, r.project_id, p.name as project_name, r.display_name, r.provider,
                r.status, r.last_seen_at, r.capabilities
         from runtimes r
         join projects p on p.id = r.project_id
         where lower(coalesce(p.status, '')) <> 'deleted'
           and (r.status <> 'removed'
                or r.updated_at > now() - make_interval(secs => $2))
           and {owner_clause}
         order by r.last_seen_at desc nulls last, r.id",
        owner_clause = attested_owner_is("$1"),
    );
    let rows = client
        .query(
            &query,
            &[&owner.to_string(), &generation_token_lifetime_bound(state)],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load the person's machines: {error}"))
        })?;
    let mut machines = Vec::new();
    let mut listed = HashSet::new();
    for row in rows {
        let provider: String = row.get("provider");
        let capabilities: JsonValue = row.get("capabilities");
        if !runtime_is_private_self_hosted(state, &provider, &capabilities)
            || self_hosted_owner_user_id(&capabilities) != Some(owner)
        {
            continue;
        }
        let runtime_id: Uuid = row.get("id");
        listed.insert(runtime_id);
        let revoked_at = owner_revoked_at(&capabilities);
        machines.push(MyRuntime {
            runtime_id,
            project_id: row.get("project_id"),
            project_readable: false,
            project_name: row.get("project_name"),
            display_name: row.get("display_name"),
            provider: Some(provider),
            status: row.get("status"),
            last_seen_at: row.get("last_seen_at"),
            minted_at: None,
            personal_browser: is_personal_browser(&capabilities),
            revoked: revoked_at.is_some(),
            revoked_at,
        });
    }

    let pending = client
        .query(
            "select m.runtime_id, m.project_id, p.name as project_name, m.created_at
             from runtime_pending_machine_mints m
             join projects p on p.id = m.project_id
             where m.owner_user_id = $1
               and m.expires_at > now()
               and lower(coalesce(p.status, '')) <> 'deleted'
             order by m.created_at desc, m.runtime_id",
            &[&owner],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load the person's pending mints: {error}"
            ))
        })?;
    for row in pending {
        let runtime_id: Uuid = row.get("runtime_id");
        if !listed.insert(runtime_id) {
            continue;
        }
        machines.push(MyRuntime {
            runtime_id,
            project_id: row.get("project_id"),
            project_readable: false,
            project_name: row.get("project_name"),
            display_name: None,
            provider: None,
            status: PENDING_STATUS.to_string(),
            last_seen_at: None,
            minted_at: row.get("created_at"),
            personal_browser: false,
            revoked: false,
            revoked_at: None,
        });
    }
    Ok(machines)
}

/// Whether the controller registered the runtime as a Personal Browser.
fn is_personal_browser(capabilities: &JsonValue) -> bool {
    capabilities
        .get("personalBrowser")
        .or_else(|| capabilities.get("personal_browser"))
        .and_then(|capability| capability.get("enabled"))
        .and_then(JsonValue::as_bool)
        == Some(true)
}

/// `POST /me/runtimes/revoke`: end the signed-in person's own machines, the
/// ones `runtimeIds` names or `all` of them. Only their own sign-in may ask.
/// A runtime still revoked is skipped, and naming one is no error. Both lists
/// of the answer empty means there was nothing to revoke.
pub(crate) async fn revoke_my_runtimes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RevokeMyRuntimesPayload>,
) -> Result<Json<RevokeMyRuntimesResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let person = require_user_session(&context)?;
    let ids = revoked_ids(payload)?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let selection = match &ids {
        None => OwnMachines::All,
        Some(ids) => OwnMachines::Ids(ids),
    };
    let ended = end_machines_of_their_owner(&state, &transaction, person, selection).await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit the revocation: {error}")))?;
    drop(connection);
    stop_revoked_machines(&state, &ended.runtimes, REVOKED_STOP_SOURCE).await;

    Ok(Json(RevokeMyRuntimesResponse {
        revoked: ended
            .runtimes
            .iter()
            .map(|runtime| runtime.runtime_id)
            .collect(),
        pending_ended: ended.pending,
    }))
}

/// Stop each of `runtimes`, which a person's revocation ended, that was still
/// running, as a person's Stop stops it, with `source` in its
/// `runtime.stopped`. Its tokens have ended either way; the stop releases a
/// running machine's jobs and revokes its tunnels now, and open tabs hear of
/// it as of a person's Stop. A stop that fails is logged.
pub(crate) async fn stop_revoked_machines(
    state: &AppState,
    runtimes: &[EndedRuntime],
    source: &'static str,
) {
    for runtime in runtimes {
        if matches!(runtime.status.as_str(), "stopped" | "offline" | "removed") {
            continue;
        }
        match super::stop_runtime_for_project(
            state,
            &runtime.project_id,
            &runtime.runtime_id,
            Some(REVOKED_STOP_REASON.to_string()),
            source,
        )
        .await
        {
            Ok(stopped) => {
                super::stop::announce_committed_stop_of(
                    state,
                    runtime.project_id,
                    runtime.runtime_id,
                    Some((REVOKED_STOP_REASON, source)),
                    stopped.skip_reason.as_deref(),
                )
                .await;
            }
            Err((status, payload)) => {
                warn!(
                    runtime_id = %runtime.runtime_id,
                    project_id = %runtime.project_id,
                    %status,
                    error = payload.0.message,
                    "failed to stop a machine its owner revoked"
                );
            }
        }
    }
}

/// The ids a revocation names, or `None` for all of the person's machines.
fn revoked_ids(
    payload: RevokeMyRuntimesPayload,
) -> Result<Option<Vec<Uuid>>, (StatusCode, Json<ApiError>)> {
    match (payload.runtime_ids, payload.all) {
        (None, Some(true)) => Ok(None),
        (Some(ids), None | Some(false)) => {
            if ids.is_empty() {
                return Err(bad_request("runtimeIds must name at least one machine."));
            }
            if ids.len() > MAX_REVOKED_IDS {
                return Err(bad_request(format!(
                    "runtimeIds may name at most {MAX_REVOKED_IDS} machines; revoke all of them instead."
                )));
            }
            let mut parsed = Vec::with_capacity(ids.len());
            for id in &ids {
                let id = Uuid::from_str(id.trim())
                    .map_err(|_| bad_request("runtimeIds must be machine ids (UUIDs)."))?;
                if !parsed.contains(&id) {
                    parsed.push(id);
                }
            }
            Ok(Some(parsed))
        }
        _ => Err(bad_request(
            "Name the machines to revoke with runtimeIds, or revoke all of them with \"all\": true.",
        )),
    }
}
