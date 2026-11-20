//! A person's own machines ([`super::super::my_machines`]), on the migrated
//! database:
//! - `GET /me/runtimes` lists the person's own private machines in every
//!   space and their pending mints, never another person's or the service's,
//!   no deleted space, no expired pending mint, and a removed runtime only
//!   while its tokens may be alive; a space's name only while they can still
//!   read it; a runtime as revoked from their revocation until a fresh mint;
//! - `POST /me/runtimes/revoke` ends the machines it names, or all of them,
//!   whatever their status and space, spaces they left, removed rows and
//!   pending mints included: their tokens are refused at their next use, and
//!   a machine that was running is stopped as a person's Stop stops it, its
//!   turn requeued and announced;
//! - it skips a runtime still revoked, and a machine cannot report itself
//!   revoked;
//! - it ends only the person's own machines, all or nothing, and only with
//!   their own sign-in;
//! - it holds the person's owner lock exclusively, so an admission under way
//!   is rotated, not missed.
//!
//! Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use std::collections::HashSet;

use axum::http::StatusCode;
use chrono::DateTime;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::runtime::run_interruptions::db_tests::{drain, insert_turn};
use crate::runtime::token::RUNTIME_TOKEN_GENERATION_CAPABILITY;
use crate::tests::{sql, sql_one};

use super::tests::{
    assert_refused, until_waiting_or_done, with_space, Space, SELF_HOSTED, SERVICE_ROLE,
    STALE_GENERATION,
};
use super::{share_runtime_owner_lock, OWNER_REVOCATION_CAPABILITY};

/// `GET /me/runtimes` with `user`'s session: the listed machines, in order.
async fn listed(space: &Space, user: Uuid) -> anyhow::Result<Vec<JsonValue>> {
    let (status, body) = space
        .call("GET", "/me/runtimes", &space.person_token(user)?, None)
        .await?;
    anyhow::ensure!(status == StatusCode::OK, "list answered {status}: {body}");
    Ok(body["runtimes"].as_array().cloned().unwrap_or_default())
}

fn ids(rows: &[JsonValue]) -> Vec<Uuid> {
    rows.iter()
        .filter_map(|row| row["runtimeId"].as_str())
        .filter_map(|id| Uuid::parse_str(id).ok())
        .collect()
}

fn id_set(values: &JsonValue) -> HashSet<Uuid> {
    values
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|id| id.as_str().and_then(|id| Uuid::parse_str(id).ok()))
        .collect()
}

fn row(rows: &[JsonValue], runtime_id: Uuid) -> JsonValue {
    rows.iter()
        .find(|row| row["runtimeId"] == json!(runtime_id))
        .cloned()
        .unwrap_or(JsonValue::Null)
}

/// `POST /me/runtimes/revoke` with `bearer`.
async fn revoke(
    space: &Space,
    bearer: &str,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    space
        .call("POST", "/me/runtimes/revoke", bearer, Some(body))
        .await
}

async fn pending_mint_exists(space: &Space, runtime_id: Uuid) -> anyhow::Result<bool> {
    Ok(sql_one::<i64>(
        &space.pool,
        "select count(*) from runtime_pending_machine_mints where runtime_id = $1",
        &[&runtime_id],
    )
    .await?
        == 1)
}

/// Whether the runtime's stored capabilities hold an owner's revocation, of
/// any generation.
async fn holds_a_revocation(space: &Space, runtime_id: Uuid) -> anyhow::Result<bool> {
    sql_one(
        &space.pool,
        "select capabilities ? $2::text from runtimes where id = $1",
        &[&runtime_id, &OWNER_REVOCATION_CAPABILITY],
    )
    .await
}

/// The runtime's `runtime_events` of `kind`, oldest first.
async fn runtime_events(
    space: &Space,
    runtime_id: Uuid,
    kind: &str,
) -> anyhow::Result<Vec<JsonValue>> {
    Ok(space
        .pool
        .get()
        .await?
        .query(
            "select data from runtime_events
             where runtime_id = $1 and kind = $2
             order by created_at, id",
            &[&runtime_id, &kind],
        )
        .await?
        .iter()
        .map(|event| event.get("data"))
        .collect())
}

/// Mark `runtime_id` removed as terminal cleanup does, two days ago: long
/// after any token it was issued expired. Every update stamps `updated_at`,
/// so this one runs past that trigger, in a transaction no other session
/// sees it off in.
async fn remove_long_ago(space: &Space, runtime_id: Uuid) -> anyhow::Result<()> {
    let mut connection = space.pool.get().await?;
    let transaction = connection.transaction().await?;
    transaction
        .batch_execute("alter table runtimes disable trigger set_runtimes_updated_at")
        .await?;
    transaction
        .execute(
            "update runtimes set status = 'removed', updated_at = now() - interval '2 days'
             where id = $1",
            &[&runtime_id],
        )
        .await?;
    transaction
        .batch_execute("alter table runtimes enable trigger set_runtimes_updated_at")
        .await?;
    transaction.commit().await?;
    Ok(())
}

#[tokio::test]
async fn a_person_lists_their_own_machines_in_every_space_and_their_pending_mints(
) -> anyhow::Result<()> {
    with_space(
        "a_person_lists_their_own_machines_in_every_space_and_their_pending_mints",
        |space| async move {
            let (owner, teammate) = (space.people.owner, space.people.teammate);
            let here = space.start_machine(teammate, space.project_id).await?;
            let there = space
                .start_machine(teammate, space.team_only_project_id)
                .await?;
            let removed_lately = space.start_machine(teammate, space.project_id).await?;
            let removed_long_ago = space.start_machine(teammate, space.project_id).await?;
            let (_, pending) = space.mint(teammate, space.project_id, json!({})).await?;
            let (_, expired) = space.mint(teammate, space.project_id, json!({})).await?;
            let owners = space.start_machine(owner, space.project_id).await?;
            let service = Uuid::new_v4();
            let (status, body) = space
                .register(
                    &space.service_runtime_token(service)?,
                    space.project_id,
                    service,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "service registration: {body}");

            // Removed as terminal cleanup removes: one just now, one long
            // after its last token expired.
            sql(
                &space.pool,
                "update runtimes set status = 'removed', last_seen_at = now() - interval '30 minutes'
                 where id = $1",
                &[&removed_lately.runtime_id],
            )
            .await?;
            remove_long_ago(&space, removed_long_ago.runtime_id).await?;
            sql(
                &space.pool,
                "update runtime_pending_machine_mints set expires_at = now() - interval '1 minute'
                 where runtime_id = $1",
                &[&expired],
            )
            .await?;
            // Seen an hour ago, and a Personal Browser.
            sql(
                &space.pool,
                "update runtimes
                 set last_seen_at = now() - interval '1 hour',
                     capabilities = capabilities || jsonb_build_object(
                         'personalBrowser',
                         jsonb_build_object('enabled', true, 'ownerUserId', $2::text)
                     )
                 where id = $1",
                &[&there.runtime_id, &teammate.to_string()],
            )
            .await?;

            let rows = listed(&space, teammate).await?;
            assert_eq!(
                ids(&rows),
                vec![
                    here.runtime_id,
                    removed_lately.runtime_id,
                    there.runtime_id,
                    pending
                ],
                "most recently seen first, then pending mints: {rows:?}"
            );
            let machine = row(&rows, here.runtime_id);
            assert_eq!(machine["projectId"], json!(space.project_id));
            assert_eq!(machine["projectReadable"], json!(true));
            assert_eq!(machine["provider"], json!("self-hosted"));
            assert_eq!(machine["status"], json!("ready"), "{machine}");
            assert!(machine["lastSeenAt"].is_string(), "{machine}");
            assert!(machine["mintedAt"].is_null(), "{machine}");
            assert_eq!(machine["personalBrowser"], json!(false));
            assert_eq!(machine["revoked"], json!(false), "{machine}");
            assert!(machine["revokedAt"].is_null(), "{machine}");
            assert_eq!(row(&rows, there.runtime_id)["personalBrowser"], json!(true));
            assert_eq!(
                row(&rows, removed_lately.runtime_id)["status"],
                json!("removed")
            );
            let minted = row(&rows, pending);
            assert_eq!(minted["status"], json!("pending"), "{minted}");
            assert!(minted["mintedAt"].is_string(), "{minted}");
            assert!(minted["provider"].is_null(), "{minted}");
            assert!(minted["lastSeenAt"].is_null(), "{minted}");
            assert_eq!(minted["revoked"], json!(false), "{minted}");
            assert!(minted["revokedAt"].is_null(), "{minted}");

            assert_eq!(ids(&listed(&space, owner).await?), vec![owners.runtime_id]);

            // A deleted space lists nothing, its pending mints included.
            let (_, pending_there) = space
                .mint(teammate, space.team_only_project_id, json!({}))
                .await?;
            assert!(ids(&listed(&space, teammate).await?).contains(&pending_there));
            sql(
                &space.pool,
                "update projects set status = 'deleted' where id = $1",
                &[&space.team_only_project_id],
            )
            .await?;
            assert_eq!(
                ids(&listed(&space, teammate).await?),
                vec![here.runtime_id, removed_lately.runtime_id, pending]
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_space_is_named_only_while_its_person_can_read_it() -> anyhow::Result<()> {
    with_space(
        "a_space_is_named_only_while_its_person_can_read_it",
        |space| async move {
            let teammate = space.people.teammate;
            let machine = space.start_machine(teammate, space.project_id).await?;
            let (_, pending) = space.mint(teammate, space.project_id, json!({})).await?;
            sql(
                &space.pool,
                "update projects set name = 'Garden plans' where id = $1",
                &[&space.project_id],
            )
            .await?;
            let rows = listed(&space, teammate).await?;
            for runtime_id in [machine.runtime_id, pending] {
                let listed = row(&rows, runtime_id);
                assert_eq!(listed["projectName"], json!("Garden plans"), "{listed}");
                assert_eq!(listed["projectReadable"], json!(true), "{listed}");
            }

            // Out of the space and its team, edited where no fence sees it:
            // the machines are still theirs to revoke, the name is not theirs
            // to read.
            sql(
                &space.pool,
                "delete from project_memberships where project_id = $1 and user_id = $2",
                &[&space.project_id, &teammate],
            )
            .await?;
            sql(
                &space.pool,
                "delete from org_memberships where org_id = $1 and user_id = $2",
                &[&space.org_id, &teammate],
            )
            .await?;
            let rows = listed(&space, teammate).await?;
            assert_eq!(ids(&rows), vec![machine.runtime_id, pending]);
            for runtime_id in [machine.runtime_id, pending] {
                let listed = row(&rows, runtime_id);
                assert_eq!(listed["projectId"], json!(space.project_id));
                assert!(listed["projectName"].is_null(), "{listed}");
                assert_eq!(listed["projectReadable"], json!(false), "{listed}");
            }
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn revoking_one_machine_ends_its_tokens_and_stops_it() -> anyhow::Result<()> {
    with_space(
        "revoking_one_machine_ends_its_tokens_and_stops_it",
        |space| async move {
            let teammate = space.people.teammate;
            let revoked = space.start_machine(teammate, space.project_id).await?;
            let kept = space.start_machine(teammate, space.project_id).await?;
            // The same computer's runtime in another space.
            let elsewhere = space
                .start_machine(teammate, space.team_only_project_id)
                .await?;
            let (generation, kept_generation, elsewhere_generation) = (
                space.generation(revoked.runtime_id).await?,
                space.generation(kept.runtime_id).await?,
                space.generation(elsewhere.runtime_id).await?,
            );

            let (status, body) = revoke(
                &space,
                &space.person_token(teammate)?,
                json!({ "runtimeIds": [revoked.runtime_id.to_string()] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["revoked"], json!([revoked.runtime_id]));
            assert_eq!(body["pendingEnded"], json!([]));

            let rotated = space.generation(revoked.runtime_id).await?;
            assert!(rotated.is_some() && rotated != generation, "{rotated:?}");
            let (status, body) = space
                .register(&revoked.renewed, space.project_id, revoked.runtime_id)
                .await?;
            assert_refused(status, &body, StatusCode::UNAUTHORIZED, STALE_GENERATION);
            assert_eq!(space.status(revoked.runtime_id).await?, "stopped");

            // Only that runtime reads as revoked; the others keep working.
            let rows = listed(&space, teammate).await?;
            assert_eq!(row(&rows, revoked.runtime_id)["revoked"], json!(true));
            for other in [&kept, &elsewhere] {
                assert_eq!(row(&rows, other.runtime_id)["revoked"], json!(false));
            }
            assert_eq!(space.generation(kept.runtime_id).await?, kept_generation);
            assert_eq!(
                space.generation(elsewhere.runtime_id).await?,
                elsewhere_generation
            );
            for other in [&kept, &elsewhere] {
                space
                    .registered(&other.renewed, other.project_id, other.runtime_id)
                    .await?;
            }
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn revoking_all_ends_offline_removed_and_pending_machines_in_every_space(
) -> anyhow::Result<()> {
    with_space(
        "revoking_all_ends_offline_removed_and_pending_machines_in_every_space",
        |space| async move {
            let (owner, teammate) = (space.people.owner, space.people.teammate);
            let online = space.start_machine(teammate, space.project_id).await?;
            let offline = space
                .start_machine(teammate, space.team_only_project_id)
                .await?;
            let removed = space.start_machine(teammate, space.project_id).await?;
            let removed_long_ago = space.start_machine(teammate, space.project_id).await?;
            sql(
                &space.pool,
                "update runtimes set status = 'offline' where id = $1",
                &[&offline.runtime_id],
            )
            .await?;
            // Removed as terminal cleanup removes, which rotates nothing.
            sql(
                &space.pool,
                "update runtimes set status = 'removed' where id = $1",
                &[&removed.runtime_id],
            )
            .await?;
            remove_long_ago(&space, removed_long_ago.runtime_id).await?;
            let long_ago_generation = space.generation(removed_long_ago.runtime_id).await?;
            let (pending_token, pending) =
                space.mint(teammate, space.project_id, json!({})).await?;
            let owners = space.start_machine(owner, space.project_id).await?;
            let owners_generation = space.generation(owners.runtime_id).await?;
            let (_, owners_pending) = space.mint(owner, space.project_id, json!({})).await?;

            let (status, body) = revoke(
                &space,
                &space.person_token(teammate)?,
                json!({ "all": true }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                id_set(&body["revoked"]),
                HashSet::from([online.runtime_id, offline.runtime_id, removed.runtime_id])
            );
            assert_eq!(body["pendingEnded"], json!([pending]));

            for machine in [&online, &offline, &removed] {
                let (status, body) = space
                    .register(&machine.renewed, machine.project_id, machine.runtime_id)
                    .await?;
                assert_refused(status, &body, StatusCode::UNAUTHORIZED, STALE_GENERATION);
            }
            let (status, body) = space
                .register(&pending_token, space.project_id, pending)
                .await?;
            assert_refused(status, &body, StatusCode::UNAUTHORIZED, STALE_GENERATION);
            // The running machine was stopped; an offline or removed machine
            // had nothing to stop.
            assert_eq!(space.status(online.runtime_id).await?, "stopped");
            assert_eq!(space.status(offline.runtime_id).await?, "offline");
            assert_eq!(space.status(removed.runtime_id).await?, "removed");
            assert_eq!(
                space.generation(removed_long_ago.runtime_id).await?,
                long_ago_generation,
                "a row removed long ago holds no live token and is left alone"
            );

            assert_eq!(
                space.generation(owners.runtime_id).await?,
                owners_generation
            );
            assert!(pending_mint_exists(&space, owners_pending).await?);
            let rows = listed(&space, teammate).await?;
            assert!(rows.iter().all(|row| row["status"] != json!("pending")));
            let mut generations = Vec::new();
            for machine in [&online, &offline, &removed] {
                let listed = row(&rows, machine.runtime_id);
                assert_eq!(listed["revoked"], json!(true), "{listed}");
                assert!(listed["revokedAt"].is_string(), "{listed}");
                generations.push(space.generation(machine.runtime_id).await?);
            }
            // Another revocation finds nothing more to end, and rotates none
            // of them again.
            let (status, body) = revoke(
                &space,
                &space.person_token(teammate)?,
                json!({ "all": true }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body, json!({ "revoked": [], "pendingEnded": [] }));
            for (machine, generation) in [&online, &offline, &removed].iter().zip(&generations) {
                assert_eq!(&space.generation(machine.runtime_id).await?, generation);
            }
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_revocation_ends_only_the_persons_own_machines_all_or_nothing() -> anyhow::Result<()> {
    with_space(
        "a_revocation_ends_only_the_persons_own_machines_all_or_nothing",
        |space| async move {
            let (owner, teammate) = (space.people.owner, space.people.teammate);
            let theirs = space.start_machine(teammate, space.project_id).await?;
            let (_, their_pending) = space.mint(teammate, space.project_id, json!({})).await?;
            let owners = space.start_machine(owner, space.project_id).await?;
            let (_, owners_pending) = space.mint(owner, space.project_id, json!({})).await?;
            let service = Uuid::new_v4();
            let (status, body) = space
                .register(
                    &space.service_runtime_token(service)?,
                    space.project_id,
                    service,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "service registration: {body}");
            let generations = || async {
                Ok::<_, anyhow::Error>((
                    space.generation(theirs.runtime_id).await?,
                    space.generation(owners.runtime_id).await?,
                    space.generation(service).await?,
                ))
            };
            let before = generations().await?;
            let bearer = space.person_token(teammate)?;
            for names in [
                json!([owners.runtime_id]),
                json!([owners_pending]),
                json!([service]),
                json!([theirs.runtime_id, owners.runtime_id]),
                json!([their_pending, owners_pending]),
                json!([theirs.runtime_id, Uuid::new_v4()]),
            ] {
                let (status, body) =
                    revoke(&space, &bearer, json!({ "runtimeIds": names })).await?;
                assert_eq!(status, StatusCode::NOT_FOUND, "{names}: {body}");
                assert!(
                    !body.to_string().contains(&owners.runtime_id.to_string()),
                    "{body}"
                );
            }
            assert_eq!(
                generations().await?,
                before,
                "a refused revocation changes nothing"
            );
            assert!(pending_mint_exists(&space, their_pending).await?);
            assert!(pending_mint_exists(&space, owners_pending).await?);

            let (status, body) = revoke(
                &space,
                &bearer,
                json!({ "runtimeIds": [theirs.runtime_id, their_pending, theirs.runtime_id] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["revoked"], json!([theirs.runtime_id]));
            assert_eq!(body["pendingEnded"], json!([their_pending]));
            assert!(pending_mint_exists(&space, owners_pending).await?);
            let after = generations().await?;
            assert_ne!(after.0, before.0);
            assert_eq!((&after.1, &after.2), (&before.1, &before.2));

            // A runtime of theirs still revoked counts as theirs and is
            // skipped; another person's id still refuses the whole revocation.
            let another = space.start_machine(teammate, space.project_id).await?;
            let another_generation = space.generation(another.runtime_id).await?;
            let (status, body) = revoke(
                &space,
                &bearer,
                json!({ "runtimeIds": [theirs.runtime_id, another.runtime_id, owners.runtime_id] }),
            )
            .await?;
            assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
            assert_eq!(
                space.generation(another.runtime_id).await?,
                another_generation
            );
            assert_eq!(generations().await?, after);
            let (status, body) = revoke(
                &space,
                &bearer,
                json!({ "runtimeIds": [theirs.runtime_id, another.runtime_id] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                body,
                json!({ "revoked": [another.runtime_id], "pendingEnded": [] })
            );
            assert_eq!(generations().await?, after);
            assert_ne!(
                space.generation(another.runtime_id).await?,
                another_generation
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn only_the_persons_own_sign_in_lists_and_revokes() -> anyhow::Result<()> {
    with_space(
        "only_the_persons_own_sign_in_lists_and_revokes",
        |space| async move {
            let teammate = space.people.teammate;
            let machine = space.start_machine(teammate, space.project_id).await?;
            let generation = space.generation(machine.runtime_id).await?;
            for bearer in [
                machine.renewed.clone(),
                machine.agent.clone(),
                SERVICE_ROLE.to_string(),
            ] {
                let (status, body) = space.call("GET", "/me/runtimes", &bearer, None).await?;
                assert_eq!(status, StatusCode::UNAUTHORIZED, "list: {body}");
                let (status, body) = revoke(&space, &bearer, json!({ "all": true })).await?;
                assert_eq!(status, StatusCode::UNAUTHORIZED, "revoke: {body}");
            }

            let bearer = space.person_token(teammate)?;
            for body in [
                json!({}),
                json!({ "all": false }),
                json!({ "runtimeIds": [] }),
                json!({ "runtimeIds": ["not-a-uuid"] }),
                json!({ "runtimeIds": [machine.runtime_id], "all": true }),
                json!({ "runtimeIds": (0..101).map(|_| Uuid::new_v4()).collect::<Vec<_>>() }),
            ] {
                let (status, answer) = revoke(&space, &bearer, body.clone()).await?;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
            }
            // An unknown field is refused before anything is read.
            let (status, answer) =
                revoke(&space, &bearer, json!({ "all": true, "spaces": [] })).await?;
            assert!(status.is_client_error(), "{status} {answer}");
            assert_eq!(space.generation(machine.runtime_id).await?, generation);
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_revocation_rotates_a_machine_admitted_at_the_same_moment() -> anyhow::Result<()> {
    with_space(
        "a_revocation_rotates_a_machine_admitted_at_the_same_moment",
        |space| async move {
            let teammate = space.people.teammate;
            let machine = space.start_machine(teammate, space.project_id).await?;

            // An admission under way: the owner lock held shared and a new
            // runtime of theirs written, not yet committed.
            let admitted = Uuid::new_v4();
            let admitted_generation = Uuid::new_v4().to_string();
            let mut connection = space.pool.get().await?;
            let admission = connection.transaction().await?;
            share_runtime_owner_lock(&admission, teammate)
                .await
                .map_err(|error| anyhow::anyhow!("owner lock: {error:?}"))?;
            admission
                .execute(
                    "insert into runtimes
                     select (jsonb_populate_record(r, jsonb_build_object(
                         'id', $2::uuid,
                         'active_lease_id', null,
                         'capabilities', jsonb_set(r.capabilities, array[$3::text], to_jsonb($4::text))
                     ))).*
                     from runtimes r where r.id = $1",
                    &[
                        &machine.runtime_id,
                        &admitted,
                        &RUNTIME_TOKEN_GENERATION_CAPABILITY,
                        &admitted_generation,
                    ],
                )
                .await?;

            let revocation = space.spawn_call(
                "POST",
                "/me/runtimes/revoke".to_string(),
                space.person_token(teammate)?,
                Some(json!({ "all": true })),
            );
            until_waiting_or_done(&space.pool, teammate, &[&revocation]).await?;
            assert!(
                !revocation.is_finished(),
                "the revocation waits for the admission"
            );
            admission.commit().await?;
            drop(connection);
            let (status, body) = revocation.await??;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                id_set(&body["revoked"]),
                HashSet::from([machine.runtime_id, admitted])
            );
            let rotated = space.generation(admitted).await?;
            assert!(
                rotated.is_some() && rotated != Some(admitted_generation),
                "{rotated:?}"
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn revoking_a_running_machine_stops_it_as_a_persons_stop_does() -> anyhow::Result<()> {
    with_space(
        "revoking_a_running_machine_stops_it_as_a_persons_stop_does",
        |space| async move {
            let teammate = space.people.teammate;
            let machine = space.start_machine(teammate, space.project_id).await?;
            // A turn the machine has leased.
            let conversation_id = Uuid::new_v4();
            sql(
                &space.pool,
                "insert into conversations (id, project_id, metadata, visibility)
                 values ($1, $2, '{}'::jsonb, 'public')",
                &[&conversation_id, &space.project_id],
            )
            .await?;
            let (job_id, run_id) = insert_turn(
                &space.pool,
                space.project_id,
                conversation_id,
                machine.runtime_id,
                "in_progress",
                true,
                json!({}),
            )
            .await?;
            let mut events = space.state.events.subscribe();

            let (status, body) = revoke(
                &space,
                &space.person_token(teammate)?,
                json!({ "runtimeIds": [machine.runtime_id] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["revoked"], json!([machine.runtime_id]));
            assert_eq!(space.status(machine.runtime_id).await?, "stopped");

            // The turn waits to resume, as after the person's Stop.
            let connection = space.pool.get().await?;
            let job = connection
                .query_one(
                    "select status, payload from agent_jobs where id = $1",
                    &[&job_id],
                )
                .await?;
            assert_eq!(job.get::<_, String>("status"), "queued");
            let payload: JsonValue = job.get("payload");
            assert_eq!(payload["requeuedReason"], json!("user_stop"), "{payload}");
            let run = connection
                .query_one(
                    "select status, progress_stage, metadata from runs where id = $1",
                    &[&run_id],
                )
                .await?;
            assert_eq!(run.get::<_, String>("status"), "queued");
            assert_eq!(
                run.get::<_, Option<String>>("progress_stage").as_deref(),
                Some("requeued")
            );
            let metadata = run
                .get::<_, Option<JsonValue>>("metadata")
                .unwrap_or(JsonValue::Null);
            assert_eq!(
                metadata["interruption"]["reason"],
                json!("user_stop"),
                "{metadata}"
            );
            assert_eq!(metadata["interruption"]["jobId"], json!(job_id));
            drop(connection);
            let stops = runtime_events(&space, machine.runtime_id, "stopped").await?;
            assert_eq!(stops.len(), 1, "{stops:?}");
            assert_eq!(stops[0]["reason"], json!("user_stop"), "{stops:?}");

            // Published as a person's stop is: the stop, then the turn.
            let published = drain(&mut events);
            let stopped: Vec<_> = published
                .iter()
                .filter(|event| event.kind == "runtime.stopped")
                .collect();
            assert_eq!(stopped.len(), 1, "{published:?}");
            assert_eq!(stopped[0].project_id, Some(space.project_id));
            assert_eq!(
                stopped[0].data,
                json!({
                    "runtimeId": machine.runtime_id,
                    "status": "stopped",
                    "reason": "user_stop",
                    "source": "me_runtimes_revoke",
                    "queuedJobCount": 1,
                })
            );
            let announced: Vec<_> = published
                .iter()
                .filter(|event| event.kind == "run.progress" && event.run_id == Some(run_id))
                .collect();
            assert_eq!(announced.len(), 1, "{published:?}");
            assert_eq!(announced[0].job_id, Some(job_id));
            assert_eq!(announced[0].conversation_id, Some(conversation_id));
            assert_eq!(announced[0].data["status"], json!("queued"));
            assert_eq!(announced[0].data["stage"], json!("requeued"));
            assert_eq!(
                announced[0].data["run"]["metadata"]["interruption"]["reason"],
                json!("user_stop")
            );
            let position = |kind: &str| published.iter().position(|event| event.kind == kind);
            assert!(
                position("runtime.stopped") < position("run.progress"),
                "{published:?}"
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_person_revokes_a_machine_in_a_space_they_left() -> anyhow::Result<()> {
    with_space(
        "a_person_revokes_a_machine_in_a_space_they_left",
        |space| async move {
            let teammate = space.people.teammate;
            let machine = space.start_machine(teammate, space.project_id).await?;
            let generation = space.generation(machine.runtime_id).await?;
            // Out of the space and its team, edited where no fence sees it:
            // nothing rotated, and the machine still runs.
            sql(
                &space.pool,
                "delete from project_memberships where project_id = $1 and user_id = $2",
                &[&space.project_id, &teammate],
            )
            .await?;
            sql(
                &space.pool,
                "delete from org_memberships where org_id = $1 and user_id = $2",
                &[&space.org_id, &teammate],
            )
            .await?;
            assert_eq!(space.status(machine.runtime_id).await?, "ready");

            let (status, body) = revoke(
                &space,
                &space.person_token(teammate)?,
                json!({ "runtimeIds": [machine.runtime_id] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["revoked"], json!([machine.runtime_id]));
            let rotated = space.generation(machine.runtime_id).await?;
            assert!(rotated.is_some() && rotated != generation, "{rotated:?}");
            assert_eq!(space.status(machine.runtime_id).await?, "stopped");
            let listed = row(&listed(&space, teammate).await?, machine.runtime_id);
            assert_eq!(listed["revoked"], json!(true), "{listed}");
            assert_eq!(listed["projectReadable"], json!(false), "{listed}");
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_revoked_machine_is_listed_revoked_and_skipped_until_a_fresh_mint() -> anyhow::Result<()>
{
    with_space(
        "a_revoked_machine_is_listed_revoked_and_skipped_until_a_fresh_mint",
        |space| async move {
            let teammate = space.people.teammate;
            let bearer = space.person_token(teammate)?;
            let machine = space.start_machine(teammate, space.project_id).await?;

            let (status, body) = revoke(&space, &bearer, json!({ "all": true })).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["revoked"], json!([machine.runtime_id]));
            let generation = space.generation(machine.runtime_id).await?;
            let revoked = row(&listed(&space, teammate).await?, machine.runtime_id);
            assert_eq!(revoked["revoked"], json!(true), "{revoked}");
            assert!(
                revoked["revokedAt"]
                    .as_str()
                    .is_some_and(|at| DateTime::parse_from_rfc3339(at).is_ok()),
                "{revoked}"
            );
            assert_eq!(revoked["status"], json!("stopped"), "{revoked}");

            // Nothing is left to revoke, all of them or that one by name: it
            // is neither rotated nor stopped again, nor listed.
            for selection in [
                json!({ "all": true }),
                json!({ "runtimeIds": [machine.runtime_id] }),
            ] {
                let (status, body) = revoke(&space, &bearer, selection.clone()).await?;
                assert_eq!(status, StatusCode::OK, "{selection}: {body}");
                assert_eq!(
                    body,
                    json!({ "revoked": [], "pendingEnded": [] }),
                    "{selection}"
                );
            }
            assert_eq!(space.generation(machine.runtime_id).await?, generation);
            assert_eq!(
                row(&listed(&space, teammate).await?, machine.runtime_id),
                revoked
            );
            assert_eq!(
                runtime_events(&space, machine.runtime_id, "stopped")
                    .await?
                    .len(),
                1
            );

            // A fresh mint names a new generation, with which the machine
            // works again: it no longer reads as revoked.
            let (token, minted_for) = space
                .mint(
                    teammate,
                    space.project_id,
                    json!({ "runtimeId": machine.runtime_id }),
                )
                .await?;
            assert_eq!(minted_for, machine.runtime_id);
            let minted = row(&listed(&space, teammate).await?, machine.runtime_id);
            assert_eq!(minted["revoked"], json!(false), "{minted}");
            assert!(minted["revokedAt"].is_null(), "{minted}");
            space
                .registered(&token, space.project_id, machine.runtime_id)
                .await?;
            assert!(!holds_a_revocation(&space, machine.runtime_id).await?);

            // And a revocation ends it again.
            let (status, body) = revoke(&space, &bearer, json!({ "all": true })).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["revoked"], json!([machine.runtime_id]));
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_machine_cannot_report_itself_revoked() -> anyhow::Result<()> {
    with_space(
        "a_machine_cannot_report_itself_revoked",
        |space| async move {
            let teammate = space.people.teammate;
            let machine = space.start_machine(teammate, space.project_id).await?;
            let generation = space.generation(machine.runtime_id).await?;

            // A registration that reports a revocation naming the machine's
            // own generation, to hide it from its owner.
            let (status, body) = space
                .call(
                    "POST",
                    "/runtime/register",
                    &machine.renewed,
                    Some(json!({
                        "projectId": space.project_id,
                        "runtimeId": machine.runtime_id,
                        "provider": SELF_HOSTED,
                        "capabilities": {
                            "agent": true,
                            "origin": true,
                            (OWNER_REVOCATION_CAPABILITY): {
                                "generation": generation,
                                "revokedAt": "2026-11-18T12:00:00Z",
                            },
                        },
                    })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(space.generation(machine.runtime_id).await?, generation);
            assert!(!holds_a_revocation(&space, machine.runtime_id).await?);
            let listed = row(&listed(&space, teammate).await?, machine.runtime_id);
            assert_eq!(listed["revoked"], json!(false), "{listed}");

            let (status, body) = revoke(
                &space,
                &space.person_token(teammate)?,
                json!({ "all": true }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["revoked"], json!([machine.runtime_id]));
            let rotated = space.generation(machine.runtime_id).await?;
            assert!(rotated.is_some() && rotated != generation, "{rotated:?}");
            Ok(())
        },
    )
    .await
}
