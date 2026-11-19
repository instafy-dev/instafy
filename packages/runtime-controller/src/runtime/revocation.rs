//! What ends a private self-hosted runtime's machine credentials before they
//! expire.
//!
//! Such a runtime acts for one person, the owner the controller attested at
//! its registration, and its runtime token renews itself at every
//! registration, so expiry alone never ends it. Two things do:
//!
//! - The runtime's token generation is rotated when it is removed, when its
//!   owner stops it with their own sign-in, and when a member or team change
//!   made through the controller leaves its owner unable to write the space.
//!   The routes that check the generation (registration, the agent lease,
//!   heartbeat and job routes, tunnels, origin capabilities) then refuse its
//!   runtime, agent and job tokens with 401 "runtime token generation is no
//!   longer current"; only a fresh mint by a person who can write the space
//!   names the new one.
//! - The owner must still be able to write the space. Registration (the
//!   renewal) and every origin capability (register and presence, applies
//!   and commit receipts, workspace lease reads, Git token mints) check it,
//!   with 403 [`RUNTIME_OWNER_ACCESS_REVOKED_CODE`]. That is what a machine
//!   meets when nothing rotated, as after a membership edited in the
//!   database: its agent and tunnel tokens then work until they expire.
//!
//! Every path that admits a machine for a person (the runtime token mint,
//! `/agent/login`, registration) holds that person's owner lock shared, and
//! every membership fence holds it exclusively, so a removal and an admission
//! never both miss each other. Idle, heartbeat and terminal-cleanup sweeps
//! never rotate: a desktop that slept comes back on the tokens it holds.

use axum::http::StatusCode;
use axum::Json;
use tokio_postgres::Transaction;
use tracing::info;
use uuid::Uuid;

use crate::projects::{load_project_record, user_may_write_project, ProjectRecord};
use crate::{internal_error, ApiError, AppState};

use super::access::{runtime_is_private_self_hosted, self_hosted_owner_user_id};
use super::register::RENEWED_RUNTIME_TOKEN_MIN_TTL_SECONDS;
use super::token::{MAX_RUNTIME_TOKEN_TTL_SECONDS, RUNTIME_TOKEN_GENERATION_CAPABILITY};

/// The code of the refusal a private self-hosted runtime gets once the person
/// it acts for can no longer write its space.
pub(crate) const RUNTIME_OWNER_ACCESS_REVOKED_CODE: &str = "runtime_owner_access_revoked";

fn owner_access_revoked() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::FORBIDDEN,
        Json(ApiError {
            message: "The person this runtime acts for can no longer write to this space."
                .to_string(),
            code: Some(RUNTIME_OWNER_ACCESS_REVOKED_CODE.to_string()),
            details: None,
        }),
    )
}

/// The person a private self-hosted runtime's machine credentials depend on:
/// its attested owner, unless that is the controller's own service identity,
/// which is no member of any space.
pub(crate) fn self_hosted_person_owner(state: &AppState, owner: Option<Uuid>) -> Option<Uuid> {
    owner.filter(|owner| state.config.service_runtime_user_id != Some(*owner))
}

/// Refuse a private self-hosted runtime whose owner can no longer write
/// `project`, with [`RUNTIME_OWNER_ACCESS_REVOKED_CODE`]. This is the check
/// the runtime token's mint makes, so a machine never keeps more than its
/// owner could mint now. Callers refuse a deleted space first, so its
/// runtimes keep getting `space_deleted`.
pub(crate) async fn ensure_self_hosted_owner_may_write(
    client: &impl tokio_postgres::GenericClient,
    project: &ProjectRecord,
    owner: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if user_may_write_project(client, project, owner).await? {
        Ok(())
    } else {
        Err(owner_access_revoked())
    }
}

fn runtime_owner_lock_key(owner: Uuid) -> String {
    format!("self-hosted-runtime-owner:{owner}")
}

/// Hold `owner`'s owner lock shared until the transaction ends: a path that
/// admits a private machine for that person, before it checks their access
/// and before it locks any row. A membership fence for them then waits for
/// this transaction and sees what it committed (a new runtime, or a successor
/// generation for one), or this one waits for the fence and sees the
/// membership change. A mint for a new runtime commits no row, so a fence
/// has nothing of it to rotate: that runtime's first registration meets the
/// owner check instead. Admissions only read memberships, so waiting here
/// closes no lock-order cycle with a fence, which holds the membership row it
/// changed.
pub(crate) async fn share_runtime_owner_lock(
    client: &impl tokio_postgres::GenericClient,
    owner: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    client
        .execute(
            "select pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
            &[&runtime_owner_lock_key(owner)],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock the runtime owner: {error}")))?;
    Ok(())
}

async fn hold_runtime_owner_lock(
    transaction: &Transaction<'_>,
    owner: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .execute(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&runtime_owner_lock_key(owner)],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock the runtime owner: {error}")))?;
    Ok(())
}

/// Give a runtime a fresh token generation, in place. Runtime, agent and job
/// tokens bound to the old one are refused at their next use: registration,
/// lease and heartbeat, tunnels, origin capabilities. One UPDATE, so a
/// registration, which rewrites `capabilities` under the row lock, either
/// commits first and is rotated on top of, or waits and then finds the new
/// generation. The key is set, never removed: a runtime without one accepts
/// any token.
pub(crate) async fn rotate_runtime_token_generation(
    client: &impl tokio_postgres::GenericClient,
    runtime_id: &Uuid,
) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    let generation = Uuid::new_v4();
    client
        .execute(
            "update runtimes
             set capabilities = jsonb_set(
                     case when jsonb_typeof(capabilities) = 'object' then capabilities
                          else '{}'::jsonb end,
                     array[$2::text],
                     to_jsonb($3::text)
                 ),
                 updated_at = now()
             where id = $1",
            &[
                runtime_id,
                &RUNTIME_TOKEN_GENERATION_CAPABILITY,
                &generation.to_string(),
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to rotate runtime token generation: {error}"
            ))
        })?;
    Ok(generation)
}

/// How long, in seconds, a runtime or agent token bound to a runtime's
/// generation can outlive the row's last `updated_at`. Every path that issues
/// one (the mint's successor generation, `/agent/login`, registration) sets
/// `updated_at` in the same transaction, a renewed runtime token lives at
/// most max(`AGENT_TOKEN_TTL_SECONDS`, an hour) and an agent token at most
/// `AGENT_TOKEN_TTL_SECONDS`; the rest covers verification leeway and clock
/// skew.
fn generation_token_lifetime_bound(state: &AppState) -> f64 {
    let longest = state
        .config
        .agent_token_ttl_seconds
        .max(RENEWED_RUNTIME_TOKEN_MIN_TTL_SECONDS)
        .max(MAX_RUNTIME_TOKEN_TTL_SECONDS);
    (longest + 300) as f64
}

/// The spaces a membership change reached.
#[derive(Clone, Copy, Debug)]
pub(crate) enum MembershipChangeScope {
    /// A direct membership of this space.
    Project(Uuid),
    /// A team membership: every space of this team.
    Org(Uuid),
}

/// After `user_id` lost a membership or was made a viewer, rotate the token
/// generation of each private self-hosted runtime they own in the spaces the
/// change reached and can no longer write. Runs in the membership change's
/// transaction, after its write, so the change and the rotations commit
/// together. A space they still write to, as its owner or through their other
/// membership, keeps its machines; a space deleted meanwhile is left to its
/// own stop. Returns the runtimes rotated.
///
/// Holds `user_id`'s owner lock exclusively first (see
/// [`share_runtime_owner_lock`]), so a machine admitted concurrently is seen
/// or refused, and a concurrent fence for the same person, from another
/// space or the team, runs after this one and sees its change. Then locks
/// only that person's runtime rows, one at a time in id order, and no project
/// row, so it cannot deadlock with a registration (owner lock, then runtime,
/// lease and project).
///
/// A runtime terminal cleanup marked `removed` is included while a token it
/// was issued may still be alive ([`generation_token_lifetime_bound`]):
/// registration takes such a runtime back once its owner can write again,
/// so its old tokens must not outlive this change. Older removed rows hold
/// no live token and are left alone.
pub(crate) async fn fence_runtimes_of_a_lost_writer(
    state: &AppState,
    transaction: &Transaction<'_>,
    user_id: Uuid,
    scope: MembershipChangeScope,
) -> Result<Vec<Uuid>, (StatusCode, Json<ApiError>)> {
    hold_runtime_owner_lock(transaction, user_id).await?;

    let (scope_filter, scope_id) = match scope {
        MembershipChangeScope::Project(project_id) => ("p.id = $1", project_id),
        MembershipChangeScope::Org(org_id) => ("p.org_id = $1", org_id),
    };
    // A prefilter on every spelling of the attested owner that
    // `self_hosted_owner_user_id` reads; the exact check runs below.
    let query = format!(
        "select r.id, r.project_id, r.provider, r.capabilities
         from runtimes r
         join projects p on p.id = r.project_id
         where {scope_filter}
           and lower(coalesce(p.status, '')) <> 'deleted'
           and (r.status <> 'removed'
                or r.updated_at > now() - make_interval(secs => $3))
           and $2::text in (
               r.capabilities #>> '{{_instafySelfHostedAccess,ownerUserId}}',
               r.capabilities #>> '{{_instafySelfHostedAccess,owner_user_id}}',
               r.capabilities #>> '{{_instafy_self_hosted_access,ownerUserId}}',
               r.capabilities #>> '{{_instafy_self_hosted_access,owner_user_id}}',
               r.capabilities #>> '{{personalBrowser,ownerUserId}}',
               r.capabilities #>> '{{personalBrowser,owner_user_id}}',
               r.capabilities #>> '{{personal_browser,ownerUserId}}',
               r.capabilities #>> '{{personal_browser,owner_user_id}}'
           )
         order by r.id"
    );
    let rows = transaction
        .query(
            &query,
            &[
                &scope_id,
                &user_id.to_string(),
                &generation_token_lifetime_bound(state),
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load the runtimes of a changed membership: {error}"
            ))
        })?;

    // Per space: whether the person may still write it, or `None` when it
    // was deleted after the query above.
    let mut checked: Vec<(Uuid, Option<bool>)> = Vec::new();
    let mut rotated = Vec::new();
    for row in rows {
        let runtime_id: Uuid = row.get("id");
        let project_id: Uuid = row.get("project_id");
        let provider: String = row.get("provider");
        let capabilities: serde_json::Value = row.get("capabilities");
        if !runtime_is_private_self_hosted(state, &provider, &capabilities)
            || self_hosted_owner_user_id(&capabilities) != Some(user_id)
        {
            continue;
        }
        let may_write = match checked.iter().find(|(id, _)| *id == project_id) {
            Some((_, may_write)) => *may_write,
            None => {
                let may_write = owner_may_still_write(transaction, &project_id, user_id).await?;
                checked.push((project_id, may_write));
                may_write
            }
        };
        if may_write != Some(false) {
            continue;
        }
        rotate_runtime_token_generation(transaction, &runtime_id).await?;
        rotated.push(runtime_id);
    }
    if !rotated.is_empty() {
        info!(
            user_id = %user_id,
            ?scope,
            runtimes = ?rotated,
            "rotated the token generation of runtimes whose owner lost write access"
        );
    }
    Ok(rotated)
}

/// Whether `user_id` may still write `project_id`, or `None` when the space is
/// gone or deleted: its delete stops its runtimes, and every route refuses
/// them, so there is nothing to fence and no reason to fail the change.
async fn owner_may_still_write(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    user_id: Uuid,
) -> Result<Option<bool>, (StatusCode, Json<ApiError>)> {
    let project = match load_project_record(transaction, project_id).await {
        Ok(project) => project,
        Err((StatusCode::NOT_FOUND, _)) => return Ok(None),
        Err(error) => return Err(error),
    };
    if project
        ._status
        .as_deref()
        .is_some_and(|status| status.eq_ignore_ascii_case("deleted"))
    {
        return Ok(None);
    }
    user_may_write_project(transaction, &project, user_id)
        .await
        .map(Some)
}

#[cfg(test)]
#[path = "revocation_tests.rs"]
mod tests;
