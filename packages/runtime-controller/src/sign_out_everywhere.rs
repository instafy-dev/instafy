//! Signing out everywhere (`POST /me/sign-out-everywhere`): a person who lost
//! a computer ends every sign-in of theirs, not only its machines.
//!
//! One transaction, under the person's owner lock held exclusively:
//!
//! - revokes each of their own private self-hosted machines and deletes each
//!   pending mint of theirs, as `POST /me/runtimes/revoke` with `all` does;
//! - revokes every device grant they gave, and cancels the requests its
//!   turns have open;
//! - revokes every preview viewer session of theirs;
//! - removes every push registration of theirs, as each device's own sign-out
//!   removes its own, so no signed-out browser or phone gets their
//!   notifications;
//! - deletes every Supabase session of theirs, and with it its refresh
//!   tokens, as Supabase's own global sign-out does: no browser, app or CLI
//!   login can refresh again;
//! - and records the moment, taken after those, in `user_sign_outs`.
//!
//! From then on the controller refuses, with `signed_out_everywhere`, every
//! credential they signed in for at or before that second: a Supabase access
//! token by its `iat`, a controller session by the sign-in it carries
//! (`crate::sign_outs`). This controller knows at once; another one at its
//! next read of the table, at most 30 seconds later. A runtime token mint, an
//! agent login, a device grant and a preview viewer session read the table
//! under the person's owner lock ([`hold_sign_in`]), so none is made from an
//! ended sign-in on any controller, and none made at the same moment
//! survives. The machines that were running are then stopped as a person's
//! Stop stops them.
//!
//! What only expires: a Supabase access token at the database API, storage
//! and realtime, which check its signature and expiry, not its session (an
//! hour by default), and the scoped tokens minted from a sign-in, which end
//! with their own expiry (git, origin and runtime tokens that are not a
//! machine's). A device that can sign in again, with a saved password or a
//! signed-in identity provider, can do so: signing out ends sign-ins, not the
//! ability to make one.

use std::time::Duration;

use anyhow::Context;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::time::MissedTickBehavior;
use tracing::warn;
use uuid::Uuid;

use crate::auth::{authenticate_request_with_sign_in, require_user_session, signed_out_everywhere};
use crate::config::{AppConfig, PgPool};
use crate::runtime::{end_machines_of_their_owner, stop_revoked_machines, OwnMachines};
use crate::sign_outs::{SignOuts, SIGN_OUT_MEMORY_SECONDS};
use crate::{internal_error, ApiError, AppState};

/// The source of the stop of a machine that was running, in its
/// `runtime.stopped`.
const SIGN_OUT_STOP_SOURCE: &str = "me_sign_out_everywhere";

/// The longest the answer waits for the second of the sign-out to pass.
const MAX_WAIT_FOR_NEXT_SECOND: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignOutEverywhereResponse {
    /// Every sign-in of the person's at or before this moment's second has
    /// ended.
    signed_out_at: DateTime<Utc>,
    /// The Supabase sessions ended: one for each browser, app or CLI login.
    sessions_ended: u64,
    /// The machines whose tokens were ended, as `POST /me/runtimes/revoke`
    /// answers `revoked`.
    machines_revoked: Vec<Uuid>,
    /// The pending mints that can no longer register.
    pending_mints_ended: Vec<Uuid>,
    device_grants_revoked: usize,
    preview_sessions_revoked: u64,
    /// The browsers and phones that no longer get their notifications.
    push_registrations_removed: u64,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/me/sign-out-everywhere", post(sign_out_everywhere))
}

/// `POST /me/sign-out-everywhere`: end every sign-in of the signed-in person,
/// this one too. Only their own sign-in may ask, and one an earlier sign-out
/// of theirs ended cannot. The answer comes once the second of the sign-out
/// has passed, so a sign-in made after it is never ended by it.
pub(crate) async fn sign_out_everywhere(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SignOutEverywhereResponse>, (StatusCode, Json<ApiError>)> {
    let authenticated = authenticate_request_with_sign_in(&state.config, &headers).await?;
    let person = require_user_session(&authenticated.context)?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    // Holds the person's owner lock exclusively first, so whatever
    // `hold_sign_in` admits for them at the same moment either committed
    // first and is ended here, or waits and is then refused.
    let machines =
        end_machines_of_their_owner(&state, &transaction, person, OwnMachines::All).await?;
    // An earlier sign-out this controller had not heard of yet ended this
    // sign-in: it signs nobody out. Dropping the transaction undoes the above.
    ensure_sign_in_not_ended(
        &state.config,
        &transaction,
        person,
        authenticated.signed_in_at,
    )
    .await?;
    let (device_grants_revoked, canceled_requests) =
        crate::device_grants::revoke_every_grant_of(&transaction, person).await?;
    let preview_sessions_revoked =
        crate::previews::revoke_preview_sessions_of(&transaction, person).await?;
    let push_registrations_removed = remove_push_registrations_of(&transaction, person).await?;
    // Deleting a session deletes its refresh tokens with it, as Supabase's
    // own global sign-out (`/logout?scope=global`) does.
    let sessions_ended = transaction
        .execute("delete from auth.sessions where user_id = $1", &[&person])
        .await
        .map_err(|error| internal_error(format!("failed to end the person's sessions: {error}")))?;
    // Taken after the sessions are gone (`clock_timestamp()`, not the
    // transaction's start), so every access token a refresh issued before
    // that is at or before it.
    let recorded = transaction
        .query_one(
            "insert into user_sign_outs as s (user_id, signed_out_at)
             values ($1, clock_timestamp())
             on conflict (user_id) do update
               set signed_out_at = greatest(s.signed_out_at, excluded.signed_out_at)
             returning s.signed_out_at,
                       floor(extract(epoch from s.signed_out_at))::bigint as cutoff",
            &[&person],
        )
        .await
        .map_err(|error| internal_error(format!("failed to record the sign-out: {error}")))?;
    let signed_out_at: DateTime<Utc> = recorded.get("signed_out_at");
    let cutoff: i64 = recorded.get("cutoff");
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit the sign-out: {error}")))?;
    drop(connection);
    state.config.sign_outs.record(person, cutoff);

    crate::provider_requests::publish_canceled_provider_requests(&state, &canceled_requests);
    stop_revoked_machines(&state, &machines.runtimes, SIGN_OUT_STOP_SOURCE).await;
    wait_past_second(cutoff).await;

    Ok(Json(SignOutEverywhereResponse {
        signed_out_at,
        sessions_ended,
        machines_revoked: machines
            .runtimes
            .iter()
            .map(|runtime| runtime.runtime_id)
            .collect(),
        pending_mints_ended: machines.pending,
        device_grants_revoked,
        preview_sessions_revoked,
        push_registrations_removed,
    }))
}

/// Remove every web push subscription and phone push token of `person`'s, as
/// each device's own sign-out removes its own. A delivery already queued for
/// one finds it gone and is dropped. Returns how many were removed.
async fn remove_push_registrations_of(
    transaction: &tokio_postgres::Transaction<'_>,
    person: Uuid,
) -> Result<u64, (StatusCode, Json<ApiError>)> {
    let mut removed = 0;
    for statement in [
        "delete from web_push_subscriptions where user_id = $1",
        "delete from native_push_tokens where user_id = $1",
    ] {
        removed += transaction
            .execute(statement, &[&person])
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to remove the person's push registrations: {error}"
                ))
            })?;
    }
    Ok(removed)
}

/// A sign-in made in the same second as the sign-out is ended too; wait until
/// that second has passed on this controller's clock.
async fn wait_past_second(cutoff: i64) {
    let left = cutoff
        .saturating_add(1)
        .saturating_mul(1000)
        .saturating_sub(Utc::now().timestamp_millis());
    if let Ok(left) = u64::try_from(left) {
        tokio::time::sleep(Duration::from_millis(left).min(MAX_WAIT_FOR_NEXT_SECOND)).await;
    }
}

/// Refuse `person`'s credential, signed in at `signed_in_at` (seconds since
/// the epoch), once a sign-out everywhere of theirs ended it, as the
/// database has it rather than this controller's memory, which learns it
/// here. A sign-in time that is unknown is ended by any sign-out.
pub(crate) async fn ensure_sign_in_not_ended(
    config: &AppConfig,
    client: &impl tokio_postgres::GenericClient,
    person: Uuid,
    signed_in_at: Option<i64>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let row = client
        .query_opt(
            "select floor(extract(epoch from signed_out_at))::bigint as cutoff
             from user_sign_outs
             where user_id = $1",
            &[&person],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to read the person's sign-out: {error}"))
        })?;
    let Some(row) = row else {
        return Ok(());
    };
    let cutoff: i64 = row.get("cutoff");
    config.sign_outs.record(person, cutoff);
    if signed_in_at.is_none_or(|signed_in_at| signed_in_at <= cutoff) {
        return Err(signed_out_everywhere());
    }
    Ok(())
}

/// Hold `person`'s owner lock shared until the transaction ends, then refuse
/// their sign-in at `signed_in_at` if a sign-out everywhere ended it
/// ([`ensure_sign_in_not_ended`]). A path that makes them a credential that
/// outlives the request calls it before it locks any row: a sign-out of
/// theirs at the same moment either committed first and is seen here, or
/// waits for this transaction and then ends what it made.
pub(crate) async fn hold_sign_in(
    config: &AppConfig,
    client: &impl tokio_postgres::GenericClient,
    person: Uuid,
    signed_in_at: Option<i64>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    crate::runtime::share_runtime_owner_lock(client, person).await?;
    ensure_sign_in_not_ended(config, client, person, signed_in_at).await
}

/// Read the sign-outs of the last [`SIGN_OUT_MEMORY_SECONDS`] into this
/// controller's memory. Returns how many it read.
pub(crate) async fn read_sign_outs(pool: &PgPool, sign_outs: &SignOuts) -> anyhow::Result<usize> {
    let connection = pool
        .get()
        .await
        .context("failed to get a connection to read sign-outs")?;
    let rows = connection
        .query(
            "select user_id, floor(extract(epoch from signed_out_at))::bigint as cutoff
             from user_sign_outs
             where signed_out_at > now() - make_interval(secs => $1)",
            &[&(SIGN_OUT_MEMORY_SECONDS as f64)],
        )
        .await
        .context("failed to read sign-outs")?;
    let read = rows.len();
    sign_outs.refresh(
        rows.iter()
            .map(|row| (row.get::<_, Uuid>("user_id"), row.get::<_, i64>("cutoff"))),
        Utc::now().timestamp() - SIGN_OUT_MEMORY_SECONDS,
    );
    Ok(read)
}

/// Read the sign-outs again every 30 seconds, for those another controller
/// recorded.
pub(crate) fn spawn_sign_out_sync(state: AppState) {
    tokio::spawn(async move {
        let mut ticker =
            crate::background_loops::staggered_interval(crate::background_loops::SIGN_OUT_SYNC);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(error) = read_sign_outs(&state.pool, &state.config.sign_outs).await {
                warn!(?error, "failed to read sign-outs");
            }
        }
    });
}
