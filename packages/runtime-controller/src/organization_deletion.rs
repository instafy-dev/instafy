//! Deleting a team.
//!
//! A team's spaces go with its row through the projects foreign key, and with
//! them their runtimes, runtime leases, tunnel grants and origin instances.
//! Deleting that row while a hosted machine of the team still runs would
//! leave the machine with no row that names it, and nothing would ever ask
//! its provider to release it. So `DELETE /orgs/:id` deletes a team in
//! phases, in a task of its own, so a client that goes away cannot leave it
//! between two of them:
//!
//! 1. The team's live Stripe subscription is canceled before any of the
//!    delete's transactions, holding no connection while Stripe answers. A
//!    cancellation that cannot be confirmed refuses the delete.
//! 2. One transaction locks the team, reads who could see it and each of its
//!    spaces, marks every space deleted and cancels its work, as a space
//!    delete does (see [`crate::project_work_cancellation`]). Once it
//!    commits, each space's deletion is published, so open tabs drop the
//!    spaces even when a later phase is refused.
//! 3. Holding no connection, every space's runtimes are stopped and released
//!    one at a time through the deleted-space stop
//!    ([`crate::runtime::stop_runtimes_of_deleted_project`]): nothing is
//!    flushed, and a hosted machine is quarantined, released through its
//!    provider and finalized.
//! 4. A second transaction deletes the team, but only while no runtime of its
//!    spaces holds a lease generation, which a provider release is keyed by
//!    and which only a confirmed release clears, and no live space was added
//!    since phase 2. Otherwise the delete answers 409
//!    [`TEAM_DELETE_INCOMPLETE_CODE`]: a repeated delete finishes it, and
//!    meanwhile the idle sweep stops the deleted spaces' runtimes on its own.
//!    Once the team is gone, everyone who could see it is told.

use std::collections::{BTreeMap, BTreeSet};

use axum::http::StatusCode;
use axum::Json;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::billing::processors::ProcessorKind;
use crate::billing::service::OrgBillingRef;
use crate::errors::{internal_error, not_found, ApiError};
use crate::project_work_cancellation::{
    cancel_project_work_in_transaction, publish_project_work_cancellation, ProjectWorkCancellation,
    CANCEL_DEADLOCKED_CODE,
};
use crate::state::{publish_project_deleted, publish_team_deleted};
use crate::AppState;

/// The code of a team delete that marked the team's spaces deleted but left
/// the team in place (see the module docs). Repeating the delete finishes it.
pub(crate) const TEAM_DELETE_INCOMPLETE_CODE: &str = "team_delete_incomplete";

/// Delete the team `org_id` for `context` (see the module docs).
pub(crate) async fn delete_organization(
    state: AppState,
    org_id: Uuid,
    context: RequestContext,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let Some(billing_ref) = check_and_load_billing(&state, &org_id, &context).await? else {
        // Recovery may repeat after the first service-role deletion
        // committed but its response was lost. Keep that narrow cleanup
        // operation idempotent without changing normal org visibility.
        return Ok(StatusCode::NO_CONTENT);
    };
    cancel_live_subscription(&state, &org_id, billing_ref).await?;

    let Some(team) = tombstone_team_spaces(&state, &org_id, &context).await? else {
        // Another delete removed the team since the checks.
        if context.is_service_role {
            return Ok(StatusCode::NO_CONTENT);
        }
        return Err(not_found("organization not found"));
    };

    for project_id in &team.project_ids {
        crate::runtime::stop_runtimes_of_deleted_project(&state, *project_id).await;
    }

    if delete_released_team(&state, &org_id).await? {
        for user_id in team.audience.everyone() {
            publish_team_deleted(&state.events, org_id, user_id);
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Refuse `context` unless it may delete the team `org_id`, and read the
/// team's billing, on a connection given back before Stripe is called.
/// `Ok(None)` when the team does not exist and the service role asks.
async fn check_and_load_billing(
    state: &AppState,
    org_id: &Uuid,
    context: &RequestContext,
) -> Result<Option<Option<OrgBillingRef>>, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start organization delete check transaction: {error}"
        ))
    })?;
    let exists = transaction
        .query_opt("select 1 from organizations where id = $1", &[org_id])
        .await
        .map_err(|error| internal_error(format!("failed to load organization: {error}")))?
        .is_some();
    if !exists {
        if context.is_service_role {
            return Ok(None);
        }
        return Err(not_found("organization not found"));
    }
    crate::projects::require_organization_deleter(&transaction, org_id, context).await?;
    let billing_ref = crate::billing::service::load_org_billing_ref(&transaction, org_id)
        .await
        .map_err(internal_error)?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize organization delete check transaction: {error}"
        ))
    })?;
    Ok(Some(billing_ref))
}

/// A deleted org must not keep billing: cancel its live Stripe subscription,
/// if it has one, and refuse the deletion when that cancellation cannot be
/// confirmed (otherwise the customer is charged forever with no portal
/// access left to stop it). Holds no connection while Stripe answers.
async fn cancel_live_subscription(
    state: &AppState,
    org_id: &Uuid,
    billing_ref: Option<OrgBillingRef>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(subscription) = billing_ref.filter(|subscription| {
        subscription.processor == "stripe"
            && matches!(
                subscription.status.as_str(),
                "active" | "trialing" | "past_due"
            )
    }) else {
        return Ok(());
    };
    if state.config.stripe.is_none() {
        return Err(internal_error(
            "cannot delete organization: it has a live Stripe subscription but Stripe is not configured on this controller",
        ));
    }
    if !subscription.external_id.starts_with("sub_") {
        return Err(internal_error(
            "cannot delete organization: its Stripe subscription reference is not a subscription id; cancel the subscription in the Stripe dashboard first",
        ));
    }
    let processor_context = crate::billing::processors::ProcessorContext {
        config: &state.config,
        http_client: &state.http_client,
    };
    crate::billing::processors::stripe::cancel_subscription(
        &processor_context,
        &subscription.external_id,
    )
    .await
    .map_err(|error| error.into_response())?;
    info!(
        org_id = %org_id,
        subscription_id = %subscription.external_id,
        "canceled Stripe subscription before organization deletion"
    );
    record_canceled_subscription(state, org_id, &subscription.external_id).await;
    Ok(())
}

/// Record a cancellation Stripe confirmed, as its webhook will, so a delete
/// repeated after a refused last phase does not cancel it again. Best
/// effort: the webhook records it too, and deleting the team removes it.
async fn record_canceled_subscription(state: &AppState, org_id: &Uuid, subscription_id: &str) {
    let recorded = async {
        let connection = state
            .pool
            .get()
            .await
            .map_err(|error| format!("failed to get connection: {error}"))?;
        crate::billing::service::update_subscription_status_by_external_id(
            &*connection,
            ProcessorKind::Stripe,
            subscription_id,
            "canceled",
        )
        .await
    }
    .await;
    if let Err(error) = recorded {
        warn!(
            org_id = %org_id,
            subscription_id,
            %error,
            "failed to record a canceled Stripe subscription before organization deletion"
        );
    }
}

/// Who could see the team and its spaces, read before anything cascades.
#[derive(Debug, Default)]
struct TeamAudience {
    org_members: BTreeSet<Uuid>,
    /// Each space's owner and direct members.
    space_members: BTreeMap<Uuid, BTreeSet<Uuid>>,
}

impl TeamAudience {
    /// Who could see the space `project_id`: its owner, its direct members
    /// and the team's members, as a space delete tells them.
    fn of_space(&self, project_id: &Uuid) -> BTreeSet<Uuid> {
        let mut audience = self.org_members.clone();
        if let Some(members) = self.space_members.get(project_id) {
            audience.extend(members);
        }
        audience
    }

    /// Everyone who could see the team or one of its spaces.
    fn everyone(&self) -> BTreeSet<Uuid> {
        let mut audience = self.org_members.clone();
        for members in self.space_members.values() {
            audience.extend(members);
        }
        audience
    }
}

async fn load_team_audience(
    client: &impl tokio_postgres::GenericClient,
    org_id: &Uuid,
) -> Result<TeamAudience, tokio_postgres::Error> {
    let rows = client
        .query(
            "select null::uuid as project_id, om.user_id
             from org_memberships om
             where om.org_id = $1
             union
             select p.id, p.owner_user_id
             from projects p
             where p.org_id = $1 and p.owner_user_id is not null
             union
             select pm.project_id, pm.user_id
             from project_memberships pm
             join projects p on p.id = pm.project_id
             where p.org_id = $1",
            &[org_id],
        )
        .await?;
    let mut audience = TeamAudience::default();
    for row in rows {
        let user_id: Uuid = row.get("user_id");
        match row.get::<_, Option<Uuid>>("project_id") {
            Some(project_id) => {
                audience
                    .space_members
                    .entry(project_id)
                    .or_default()
                    .insert(user_id);
            }
            None => {
                audience.org_members.insert(user_id);
            }
        }
    }
    Ok(audience)
}

/// What marking the team's spaces deleted committed.
#[derive(Debug)]
struct TombstonedTeam {
    /// Every space of the team, in id order: those this delete marked
    /// deleted and those deleted before, whose machines may still run.
    project_ids: Vec<Uuid>,
    /// The spaces this delete marked deleted, with the work it canceled.
    tombstoned: Vec<(Uuid, ProjectWorkCancellation)>,
    audience: TeamAudience,
}

/// Mark every space of the team `org_id` deleted and cancel its work in one
/// transaction, then publish each newly deleted space's deletion. `Ok(None)`
/// when the team is gone.
async fn tombstone_team_spaces(
    state: &AppState,
    org_id: &Uuid,
    context: &RequestContext,
) -> Result<Option<TombstonedTeam>, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    // Run once more if Postgres ends a space's cancel as one side of a
    // deadlock, as a space delete does: everything was rolled back, the
    // tombstone only changes spaces that are not deleted yet, and the cancel
    // is idempotent.
    let mut retried_deadlock = false;
    let team = loop {
        let mut transaction = connection.transaction().await.map_err(|error| {
            internal_error(format!(
                "failed to start organization delete transaction: {error}"
            ))
        })?;

        // The team's row lock keeps a space from being added until the
        // commit; the last phase looks for one added after it.
        let locked = transaction
            .query_opt(
                "select 1 from organizations where id = $1 for update",
                &[org_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to lock organization: {error}")))?;
        if locked.is_none() {
            return Ok(None);
        }
        // Again under the lock: the role may have changed while Stripe
        // answered.
        crate::projects::require_organization_deleter(&transaction, org_id, context).await?;

        let spaces = transaction
            .query(
                "select id, status from projects where org_id = $1 order by id for update",
                &[org_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to lock organization spaces: {error}"))
            })?;
        let project_ids: Vec<Uuid> = spaces.iter().map(|row| row.get("id")).collect();
        let live: Vec<Uuid> = spaces
            .iter()
            .filter(|row| row.get::<_, String>("status") != "deleted")
            .map(|row| row.get("id"))
            .collect();
        let audience = load_team_audience(&transaction, org_id)
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to load who could see the organization: {error}"
                ))
            })?;

        if !live.is_empty() {
            transaction
                .execute(
                    "update projects set status = 'deleted', updated_at = now()
                     where id = any($1) and status <> 'deleted'",
                    &[&live],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to delete organization spaces: {error}"))
                })?;
        }
        let mut tombstoned = Vec::with_capacity(live.len());
        let mut deadlocked = None;
        for project_id in &live {
            match cancel_project_work_in_transaction(&mut transaction, *project_id).await {
                Ok(work) => tombstoned.push((*project_id, work)),
                Err((status, Json(error)))
                    if error.code.as_deref() == Some(CANCEL_DEADLOCKED_CODE) =>
                {
                    deadlocked = Some((status, error));
                    break;
                }
                Err(error) => return Err(error),
            }
        }
        if let Some((status, error)) = deadlocked {
            let _ = transaction.rollback().await;
            if retried_deadlock {
                error!(
                    org_id = %org_id,
                    error = %error.message,
                    "an organization delete deadlocked on its spaces' work again"
                );
                return Err((status, Json(error)));
            }
            warn!(
                org_id = %org_id,
                error = %error.message,
                "an organization delete deadlocked on its spaces' work; running it once more"
            );
            retried_deadlock = true;
            continue;
        }

        // Keep encrypted browser identity data tied to the org lifecycle even
        // on installations that have not yet acquired the cascade FK from
        // migration 20260000000048, as a space delete does.
        transaction
            .execute(
                "delete from project_browser_profiles where project_id = any($1)",
                &[&project_ids],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to delete organization browser profiles: {error}"
                ))
            })?;

        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finalize organization delete transaction: {error}"
            ))
        })?;
        break TombstonedTeam {
            project_ids,
            tombstoned,
            audience,
        };
    };
    info!(
        org_id = %org_id,
        spaces = team.project_ids.len(),
        newly_deleted = team.tombstoned.len(),
        "marked an organization's spaces deleted"
    );

    // Browsers lost access with the status change; this frees the spaces'
    // chat attachments and never fails the delete.
    crate::chat_attachments::spawn_projects_purge(
        crate::chat_attachments::StorageAccess::from_config(&state.http_client, &state.config),
        team.project_ids.clone(),
    );
    for (project_id, work) in &team.tombstoned {
        publish_project_work_cancellation(state, &*connection, *project_id, work).await;
    }
    drop(connection);
    // One event per user and space reaches all of their open tabs, on any
    // space. A space deleted before was announced by its own delete.
    for (project_id, _) in &team.tombstoned {
        for user_id in team.audience.of_space(project_id) {
            publish_project_deleted(&state.events, *project_id, user_id);
        }
    }
    Ok(Some(team))
}

/// Delete the team `org_id`, whose spaces were marked deleted and whose
/// machines were stopped, unless that is unfinished: a runtime of one of its
/// spaces still holds a lease generation, so its provider release was not
/// confirmed, or a live space was added. `Ok(false)` when another delete
/// removed the team first.
async fn delete_released_team(
    state: &AppState,
    org_id: &Uuid,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start organization delete transaction: {error}"
        ))
    })?;
    let locked = transaction
        .query_opt(
            "select 1 from organizations where id = $1 for update",
            &[org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock organization: {error}")))?;
    if locked.is_none() {
        return Ok(false);
    }
    // A launch revalidates its space under a share lock before it creates a
    // lease generation, so with the spaces locked none can be added before
    // the commit.
    let live_spaces = transaction
        .query(
            "select id, status from projects where org_id = $1 order by id for update",
            &[org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock organization spaces: {error}")))?
        .iter()
        .filter(|row| row.get::<_, String>("status") != "deleted")
        .count();
    let unreleased: Vec<Uuid> = transaction
        .query(
            "select r.id
             from runtimes r
             join projects p on p.id = r.project_id
             where p.org_id = $1 and r.active_lease_id is not null
             order by r.id
             for update of r",
            &[org_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to check the organization's runtimes for releases: {error}"
            ))
        })?
        .iter()
        .map(|row| row.get("id"))
        .collect();
    if live_spaces > 0 || !unreleased.is_empty() {
        let _ = transaction.rollback().await;
        warn!(
            org_id = %org_id,
            live_spaces,
            unreleased_runtimes = ?unreleased,
            "left an organization in place until its spaces' machines are released"
        );
        return Err(team_delete_incomplete(live_spaces > 0));
    }

    transaction
        .execute("delete from organizations where id = $1", &[org_id])
        .await
        .map_err(|error| internal_error(format!("failed to delete organization: {error}")))?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize organization delete transaction: {error}"
        ))
    })?;
    info!(org_id = %org_id, "deleted an organization");
    Ok(true)
}

/// The refusal of a team delete that left the team in place (see
/// [`TEAM_DELETE_INCOMPLETE_CODE`]).
fn team_delete_incomplete(space_added: bool) -> (StatusCode, Json<ApiError>) {
    let message = if space_added {
        "A space was added to this team while it was being deleted. Delete the team again to finish."
    } else {
        "This team's spaces are deleted, but some of their machines are still being released. Delete the team again in a few minutes to finish."
    };
    (
        StatusCode::CONFLICT,
        Json(ApiError {
            message: message.to_string(),
            code: Some(TEAM_DELETE_INCOMPLETE_CODE.to_string()),
            details: None,
        }),
    )
}

#[cfg(test)]
#[path = "organization_deletion_tests.rs"]
mod db_tests;
