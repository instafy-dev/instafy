//! What ends a private self-hosted runtime's machine credentials before they
//! expire.
//!
//! Such a runtime acts for one person, the owner the controller attested at
//! its registration, and its runtime token renews itself at every
//! registration, so expiry alone never ends it. Three things do:
//!
//! - Its lifetime. The runtime token a person mints for a machine carries a
//!   signed machine expiry, `SELF_HOSTED_MACHINE_LIFETIME_SECONDS` after the
//!   mint, and every renewal carries it unchanged; registration stops
//!   renewing once a renewed token would outlive it, with 401
//!   [`RUNTIME_MACHINE_LIFETIME_ENDED_CODE`], so no runtime or agent token
//!   of the machine outlives it. A job leased shortly before the end keeps
//!   the tokens minted for it at its lease, such as its workspace token,
//!   for max(`AGENT_TOKEN_TTL_SECONDS`, an hour) after that lease. Desktop
//!   and the CLI then mint again with the person's sign-in, which checks
//!   their access again, and start the machine anew.
//! - The runtime's token generation is rotated when it is removed, when its
//!   owner stops it with their own sign-in, when its owner revokes it from
//!   their own machines ([`end_machines_of_their_owner`]), and when a member
//!   or team change made through the controller leaves its owner unable to
//!   write the space.
//!   The routes that check the generation (registration, the agent lease,
//!   heartbeat and job routes, tunnels, origin capabilities) then refuse its
//!   runtime, agent and job tokens with 401 "runtime token generation is no
//!   longer current"; only a fresh mint by a person who can write the space
//!   names the new one. A revocation by the owner also records the generation
//!   it gave ([`OWNER_REVOCATION_CAPABILITY`]), so the runtime reads as
//!   revoked until something rotates it again.
//! - The owner must still be able to write the space. Registration (the
//!   renewal) and every origin capability (register and presence, applies
//!   and commit receipts, workspace lease reads, Git token mints) check it,
//!   with 403 [`RUNTIME_OWNER_ACCESS_REVOKED_CODE`]. That is what a machine
//!   meets when nothing rotated, as after a membership edited in the
//!   database: its agent and tunnel tokens then work until they expire.
//!
//! Every path that admits a machine for a person (the runtime token mint,
//! `/agent/login`, registration) holds that person's owner lock shared, and
//! every membership fence and every revocation by the owner holds it
//! exclusively, so a removal and an admission never both miss each other. A mint for a new machine has no runtime row
//! for a fence to rotate, so it records a pending mint
//! ([`record_pending_machine_mint`]); the fence deletes the person's pending
//! mints where they can no longer write, and the machine's first
//! registration needs its own ([`consume_pending_machine_mint`]). Idle,
//! heartbeat and terminal-cleanup sweeps never rotate: a desktop that slept
//! comes back on the tokens it holds.

use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use tokio_postgres::Transaction;
use tracing::info;
use uuid::Uuid;

use crate::projects::{load_project_record, user_may_write_project, ProjectRecord};
use crate::{internal_error, ApiError, AppState};

use super::access::{runtime_is_private_self_hosted, self_hosted_owner_user_id};
use super::register::RENEWED_RUNTIME_TOKEN_MIN_TTL_SECONDS;
use super::token::{
    runtime_generation_from_capabilities, MAX_RUNTIME_TOKEN_TTL_SECONDS,
    RUNTIME_TOKEN_GENERATION_CAPABILITY,
};

/// The code of the refusal a private self-hosted runtime gets once the person
/// it acts for can no longer write its space.
pub(crate) const RUNTIME_OWNER_ACCESS_REVOKED_CODE: &str = "runtime_owner_access_revoked";

/// The code of the 401 a person's private self-hosted machine gets from
/// registration once a renewed token would outlive its machine expiry. Its
/// tokens still work until they expire; the person's sign-in mints it again.
pub(crate) const RUNTIME_MACHINE_LIFETIME_ENDED_CODE: &str = "runtime_machine_lifetime_ended";

/// The refusal a machine whose pending mint is gone gets at its first
/// registration: what a rotated runtime's tokens get.
const STALE_GENERATION_MESSAGE: &str = "runtime token generation is no longer current";

fn machine_lifetime_ended() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(ApiError {
            message: "This machine's credentials reached the end of their lifetime; mint a new runtime token to keep it running."
                .to_string(),
            code: Some(RUNTIME_MACHINE_LIFETIME_ENDED_CODE.to_string()),
            details: None,
        }),
    )
}

/// The machine expiry a registration renews a person's machine with, or the
/// refusal once a token renewed for `renewed_ttl_seconds` would outlive it.
/// A token minted before the claim existed starts its lifetime now.
/// Registration checks this after the generation and the owner, so a machine
/// that was ended, or whose owner lost access, is told that, not to mint
/// again.
pub(crate) fn renewable_machine_expiry(
    state: &AppState,
    presented: Option<i64>,
    renewed_ttl_seconds: i64,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, (StatusCode, Json<ApiError>)> {
    let expires_at = match presented {
        Some(expires_at) => DateTime::<Utc>::from_timestamp(expires_at, 0)
            .ok_or_else(|| crate::unauthorized("runtime token machine expiry is invalid"))?,
        None => now + chrono::Duration::seconds(state.config.self_hosted_machine_lifetime_seconds),
    };
    if now + chrono::Duration::seconds(renewed_ttl_seconds) > expires_at {
        return Err(machine_lifetime_ended());
    }
    Ok(expires_at)
}

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

/// Record the runtime token just minted for a new machine of `owner`, whose
/// runtime has no row yet, in the mint's transaction and under `owner`'s
/// owner lock. A service mint naming an id that is already pending replaces
/// its row, so only the newest token's generation registers.
pub(crate) async fn record_pending_machine_mint(
    client: &impl tokio_postgres::GenericClient,
    runtime_id: Uuid,
    project_id: Uuid,
    owner: Uuid,
    generation: Uuid,
    token_expires_at: DateTime<Utc>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    client
        .execute(
            "insert into runtime_pending_machine_mints
                 (runtime_id, project_id, owner_user_id, generation, expires_at)
             values ($1, $2, $3, $4, $5)
             on conflict (runtime_id) do update
             set project_id = excluded.project_id,
                 owner_user_id = excluded.owner_user_id,
                 generation = excluded.generation,
                 created_at = now(),
                 expires_at = excluded.expires_at",
            &[
                &runtime_id,
                &project_id,
                &owner,
                &generation,
                &token_expires_at,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to record the pending machine mint: {error}"
            ))
        })?;
    Ok(())
}

/// A person's machine registers for the first time: delete the pending mint
/// its token names, or refuse it as a rotated runtime is refused when there
/// is none (a membership change ended it, or a newer mint for the same id
/// replaced it). Runs in the registration's transaction, under `owner`'s
/// owner lock and the new runtime row's lock, so a fence either finds the row
/// this commits or deleted the pending mint before.
pub(crate) async fn consume_pending_machine_mint(
    transaction: &Transaction<'_>,
    runtime_id: Uuid,
    project_id: Uuid,
    owner: Uuid,
    generation: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let deleted = transaction
        .execute(
            "delete from runtime_pending_machine_mints
             where runtime_id = $1
               and project_id = $2
               and owner_user_id = $3
               and generation = $4",
            &[&runtime_id, &project_id, &owner, &generation],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to read the pending machine mint: {error}"))
        })?;
    if deleted == 0 {
        return Err(crate::unauthorized(STALE_GENERATION_MESSAGE));
    }
    Ok(())
}

/// Delete pending mints whose tokens have expired, as the retention ticker
/// does: a token that can no longer register needs no row. Bounded per call,
/// so a backlog drains over a few ticks.
pub(crate) async fn prune_expired_pending_machine_mints(
    pool: &crate::config::PgPool,
) -> anyhow::Result<u64> {
    let connection = pool
        .get()
        .await
        .map_err(|error| anyhow::anyhow!("failed to get connection: {error}"))?;
    let deleted = connection
        .execute(
            "delete from runtime_pending_machine_mints
             where runtime_id in (
               select runtime_id
               from runtime_pending_machine_mints
               where expires_at < now() - interval '5 minutes'
               limit 1000
             )",
            &[],
        )
        .await?;
    if deleted > 0 {
        info!(deleted, "pruned expired pending machine mints");
    }
    Ok(deleted)
}

/// How long, in seconds, a runtime or agent token bound to a runtime's
/// generation can outlive the row's last `updated_at`. Every path that issues
/// one (the mint's successor generation, `/agent/login`, registration) sets
/// `updated_at` in the same transaction, a renewed runtime token lives at
/// most max(`AGENT_TOKEN_TTL_SECONDS`, an hour) and an agent token at most
/// `AGENT_TOKEN_TTL_SECONDS`; the rest covers verification leeway and clock
/// skew.
pub(super) fn generation_token_lifetime_bound(state: &AppState) -> f64 {
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
/// change reached and can no longer write, and delete their pending mints
/// there, so a machine minted but not yet registered cannot register either.
/// Runs in the membership change's transaction, after its write, so the
/// change and the rotations commit together. A space they still write to, as
/// its owner or through their other membership, keeps its machines; a space
/// deleted meanwhile is left to its own stop. Returns the runtimes rotated.
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
    // A prefilter on the attested owner; the exact check runs below.
    let query = format!(
        "select r.id, r.project_id, r.provider, r.capabilities
         from runtimes r
         join projects p on p.id = r.project_id
         where {scope_filter}
           and lower(coalesce(p.status, '')) <> 'deleted'
           and (r.status <> 'removed'
                or r.updated_at > now() - make_interval(secs => $3))
           and {owner_clause}
         order by r.id",
        owner_clause = attested_owner_is("$2"),
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

    let pending_query = format!(
        "select m.runtime_id, m.project_id
         from runtime_pending_machine_mints m
         join projects p on p.id = m.project_id
         where {scope_filter}
           and m.owner_user_id = $2
         order by m.runtime_id"
    );
    // A pending mint in a space deleted meanwhile is ended too: its machine
    // could never register there.
    let mut ended_pending = Vec::new();
    let pending = transaction
        .query(&pending_query, &[&scope_id, &user_id])
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load the pending machine mints of a changed membership: {error}"
            ))
        })?;
    for row in pending {
        let runtime_id: Uuid = row.get("runtime_id");
        let project_id: Uuid = row.get("project_id");
        let may_write = match checked.iter().find(|(id, _)| *id == project_id) {
            Some((_, may_write)) => *may_write,
            None => {
                let may_write = owner_may_still_write(transaction, &project_id, user_id).await?;
                checked.push((project_id, may_write));
                may_write
            }
        };
        if may_write == Some(true) {
            continue;
        }
        transaction
            .execute(
                "delete from runtime_pending_machine_mints where runtime_id = $1",
                &[&runtime_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to end a pending machine mint: {error}"))
            })?;
        ended_pending.push(runtime_id);
    }
    if !rotated.is_empty() || !ended_pending.is_empty() {
        info!(
            user_id = %user_id,
            ?scope,
            runtimes = ?rotated,
            pending_mints = ?ended_pending,
            "ended the machine credentials of runtimes whose owner lost write access"
        );
    }
    Ok(rotated)
}

/// The SQL condition that a runtime `r`'s attested owner is the text
/// parameter `param`, on every spelling of the owner that
/// [`self_hosted_owner_user_id`] reads. A prefilter only: callers check each
/// row with [`runtime_is_private_self_hosted`] and that function.
pub(super) fn attested_owner_is(param: &str) -> String {
    format!(
        "{param}::text in (
             r.capabilities #>> '{{_instafySelfHostedAccess,ownerUserId}}',
             r.capabilities #>> '{{_instafySelfHostedAccess,owner_user_id}}',
             r.capabilities #>> '{{_instafy_self_hosted_access,ownerUserId}}',
             r.capabilities #>> '{{_instafy_self_hosted_access,owner_user_id}}',
             r.capabilities #>> '{{personalBrowser,ownerUserId}}',
             r.capabilities #>> '{{personalBrowser,owner_user_id}}',
             r.capabilities #>> '{{personal_browser,ownerUserId}}',
             r.capabilities #>> '{{personal_browser,owner_user_id}}'
         )"
    )
}

/// The controller-owned capability in which [`end_machines_of_their_owner`]
/// records a revocation by the runtime's owner:
/// `{"generation": "<uuid>", "revokedAt": "<rfc3339>"}`, the token generation
/// that revocation gave the runtime, and when. Registration strips it from what
/// a runtime reports (`super::register`), so a machine cannot mark itself
/// revoked to hide from its owner's list and from their Revoke all.
pub(crate) const OWNER_REVOCATION_CAPABILITY: &str = "_instafyOwnerRevocation";

/// When the runtime's owner revoked it, while that revocation still holds: the
/// [`OWNER_REVOCATION_CAPABILITY`] names the runtime's current token
/// generation. Any later rotation (a fresh mint's successor generation, a
/// person's stop or removal, a membership fence) changes the generation, and
/// the runtime no longer reads as revoked. A machine can work again only after
/// a fresh mint, so a live machine never reads as revoked.
pub(crate) fn owner_revoked_at(capabilities: &JsonValue) -> Option<DateTime<Utc>> {
    let revocation = capabilities.get(OWNER_REVOCATION_CAPABILITY)?;
    let revoked_generation = revocation
        .get("generation")
        .and_then(JsonValue::as_str)
        .and_then(|generation| Uuid::parse_str(generation.trim()).ok())?;
    let current = runtime_generation_from_capabilities(capabilities).ok()??;
    if revoked_generation != current {
        return None;
    }
    let revoked_at = revocation.get("revokedAt").and_then(JsonValue::as_str)?;
    DateTime::parse_from_rfc3339(revoked_at)
        .ok()
        .map(|revoked_at| revoked_at.with_timezone(&Utc))
}

/// Record that the runtime's owner revoked it with `generation`, the one
/// [`rotate_runtime_token_generation`] just gave it, at the transaction's time
/// ([`OWNER_REVOCATION_CAPABILITY`]). Runs right after that rotation, under
/// the row lock it holds.
async fn record_owner_revocation(
    transaction: &Transaction<'_>,
    runtime_id: &Uuid,
    generation: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .execute(
            "update runtimes
             set capabilities = jsonb_set(
                     capabilities,
                     array[$2::text],
                     jsonb_build_object('generation', $3::text, 'revokedAt', to_jsonb(now()))
                 )
             where id = $1",
            &[
                runtime_id,
                &OWNER_REVOCATION_CAPABILITY,
                &generation.to_string(),
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to record the owner's revocation: {error}"))
        })?;
    Ok(())
}

/// Which of a person's own machines their revocation ends.
#[derive(Clone, Copy, Debug)]
pub(crate) enum OwnMachines<'a> {
    All,
    Ids(&'a [Uuid]),
}

/// A runtime a person's revocation rotated.
#[derive(Debug)]
pub(crate) struct EndedRuntime {
    pub(crate) runtime_id: Uuid,
    pub(crate) project_id: Uuid,
    /// Its status before the revocation.
    pub(crate) status: String,
}

/// What a person's revocation ended.
#[derive(Debug, Default)]
pub(crate) struct EndedMachines {
    /// The runtimes whose tokens it ended, not those an earlier revocation
    /// had ended already.
    pub(crate) runtimes: Vec<EndedRuntime>,
    /// The runtime ids of the pending mints it deleted.
    pub(crate) pending: Vec<Uuid>,
}

/// End `owner`'s own private self-hosted machines, as they asked with their
/// own sign-in: rotate the token generation of each selected runtime the
/// controller attested as theirs, in any space and whatever its status, record
/// that generation as revoked by them ([`OWNER_REVOCATION_CAPABILITY`]), and
/// delete each selected pending mint of theirs. A runtime terminal cleanup
/// marked `removed` is included while a token it was issued may still be
/// alive, as in [`fence_runtimes_of_a_lost_writer`]; older removed rows hold
/// none and are left alone. A runtime still revoked ([`owner_revoked_at`]) is
/// skipped: not rotated again and not returned.
///
/// Holds `owner`'s owner lock exclusively first, as a membership fence does,
/// so a mint, agent login or registration admitted for them at the same
/// moment either committed first and is rotated or deleted here, or waits and
/// then meets the new generation or a missing pending mint. Then locks only
/// their runtime rows, one at a time in id order, and no project row. Each row
/// is read again under its lock, which a mint and a registration take too,
/// before the check that skips it, so no new generation lands between the
/// check and the rotation.
///
/// With ids, each must be a runtime or a pending mint of theirs, or the
/// revocation is refused as not found and changes nothing once the caller
/// drops the transaction; the refusal never says whether another person's
/// machine has that id. A runtime of theirs that is still revoked counts as
/// theirs. The caller commits.
pub(crate) async fn end_machines_of_their_owner(
    state: &AppState,
    transaction: &Transaction<'_>,
    owner: Uuid,
    selection: OwnMachines<'_>,
) -> Result<EndedMachines, (StatusCode, Json<ApiError>)> {
    hold_runtime_owner_lock(transaction, owner).await?;
    let ids: Option<Vec<Uuid>> = match selection {
        OwnMachines::All => None,
        OwnMachines::Ids(ids) => Some(ids.to_vec()),
    };
    // Every space at once, so no index narrows it: a revocation is rare and
    // asked for by a person.
    let query = format!(
        "select r.id, r.project_id, r.provider, r.capabilities
         from runtimes r
         where ($2::uuid[] is null or r.id = any($2::uuid[]))
           and (r.status <> 'removed'
                or r.updated_at > now() - make_interval(secs => $3))
           and {owner_clause}
         order by r.id",
        owner_clause = attested_owner_is("$1"),
    );
    let rows = transaction
        .query(
            &query,
            &[
                &owner.to_string(),
                &ids,
                &generation_token_lifetime_bound(state),
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load the person's machines: {error}"))
        })?;
    let mut ended = EndedMachines::default();
    // Runtimes of theirs an earlier revocation ended, which this one skips.
    let mut still_revoked = Vec::new();
    for row in rows {
        let provider: String = row.get("provider");
        let capabilities: JsonValue = row.get("capabilities");
        if !runtime_is_private_self_hosted(state, &provider, &capabilities)
            || self_hosted_owner_user_id(&capabilities) != Some(owner)
        {
            continue;
        }
        let runtime_id: Uuid = row.get("id");
        // The lock the rotation would take, so the row read here is the one
        // the rotation changes.
        let Some(locked) = transaction
            .query_opt(
                "select capabilities, status from runtimes where id = $1 for no key update",
                &[&runtime_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to lock the person's machine: {error}"))
            })?
        else {
            continue;
        };
        if owner_revoked_at(&locked.get("capabilities")).is_some() {
            still_revoked.push(runtime_id);
            continue;
        }
        let generation = rotate_runtime_token_generation(transaction, &runtime_id).await?;
        record_owner_revocation(transaction, &runtime_id, generation).await?;
        ended.runtimes.push(EndedRuntime {
            runtime_id,
            project_id: row.get("project_id"),
            status: locked.get("status"),
        });
    }
    ended.pending = transaction
        .query(
            "delete from runtime_pending_machine_mints
             where owner_user_id = $1
               and ($2::uuid[] is null or runtime_id = any($2::uuid[]))
             returning runtime_id",
            &[&owner, &ids],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to end the person's pending mints: {error}"))
        })?
        .iter()
        .map(|row| row.get(0))
        .collect();
    ended.pending.sort();
    if let Some(ids) = &ids {
        let theirs = |id: &Uuid| {
            ended
                .runtimes
                .iter()
                .any(|runtime| runtime.runtime_id == *id)
                || still_revoked.contains(id)
                || ended.pending.contains(id)
        };
        if !ids.iter().all(theirs) {
            return Err(crate::not_found("No machine of yours has that id."));
        }
    }
    if !ended.runtimes.is_empty() || !ended.pending.is_empty() {
        info!(
            %owner,
            runtimes = ?ended.runtimes.iter().map(|runtime| runtime.runtime_id).collect::<Vec<_>>(),
            pending_mints = ?ended.pending,
            "a person revoked their own machines"
        );
    }
    Ok(ended)
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

#[cfg(test)]
#[path = "machine_lifetime_tests.rs"]
mod machine_lifetime_tests;

#[cfg(test)]
#[path = "my_machines_tests.rs"]
mod my_machines_tests;

#[cfg(test)]
#[path = "sign_out_everywhere_tests.rs"]
mod sign_out_everywhere_tests;
