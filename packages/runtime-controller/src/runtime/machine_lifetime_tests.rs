//! How long a person's private self-hosted machine keeps its credentials
//! ([`super`]), on the migrated database:
//! - a mint signs a machine expiry that every renewal carries unchanged, and
//!   no renewed token outlives it; once one would, registration refuses with
//!   `runtime_machine_lifetime_ended` while the machine's tokens keep working
//!   until they expire;
//! - a token minted before lifetimes starts one at its next renewal, and a
//!   service-owned runtime never has one;
//! - a person's mint never outlives the session that makes it, even one that
//!   waits on a lock, and a session about to expire is refused as expired;
//! - a mint for a new machine waits as a pending mint that its first
//!   registration takes, and a retried first registration still works;
//! - a removal ends the pending mints where the person lost write access, so
//!   a mint from before the removal stays ended once they are back;
//! - the retention ticker prunes pending mints whose tokens have expired.
//!
//! Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use std::future::Future;
use std::time::Duration;

use axum::http::StatusCode;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::auth::{issue_controller_token, ControllerToken};
use crate::config::DEFAULT_SELF_HOSTED_MACHINE_LIFETIME_SECONDS;
use crate::runtime::token::default_runtime_token_scopes;
use crate::tests::{assert_controller_only, eventually, sql, sql_one};
use crate::tokens::{
    decode_scoped_token_in_full, mint_runtime_machine_token,
    mint_scoped_token_with_runtime_generation, ScopedTokenRequest,
};

use super::tests::{
    assert_refused, with_configured_space, with_space, People, Space, SERVICE_ROLE,
};
use super::{
    hold_runtime_owner_lock, prune_expired_pending_machine_mints,
    RUNTIME_MACHINE_LIFETIME_ENDED_CODE,
};

/// The machine expiry `token` carries, if any.
fn machine_expiry(space: &Space, token: &str) -> anyhow::Result<Option<i64>> {
    Ok(
        decode_scoped_token_in_full(&space.config, token, "runtime token")
            .map_err(|error| anyhow::anyhow!("invalid runtime token: {error:?}"))?
            .machine_expires_at,
    )
}

fn token_expiry(space: &Space, token: &str) -> anyhow::Result<i64> {
    Ok(
        decode_scoped_token_in_full(&space.config, token, "runtime token")
            .map_err(|error| anyhow::anyhow!("invalid runtime token: {error:?}"))?
            .claims
            .exp,
    )
}

/// The runtime token a person's machine holds for `runtime_id`, signed as
/// registration signs one; `machine_expires_at` `None` signs one from before
/// lifetimes.
fn machine_token(
    space: &Space,
    person: Uuid,
    project_id: Uuid,
    runtime_id: Uuid,
    generation: Uuid,
    machine_expires_at: Option<DateTime<Utc>>,
) -> anyhow::Result<String> {
    let request = ScopedTokenRequest {
        audience: runtime_id.to_string(),
        subject: person.to_string(),
        project_id: project_id.to_string(),
        origin_id: None,
        runtime_id: Some(runtime_id.to_string()),
        protocol: None,
        scopes: default_runtime_token_scopes(),
        lease_id: None,
        run_id: None,
        prefer_runtime: None,
        ttl_seconds: Some(3600),
    };
    let minted = match machine_expires_at {
        Some(expires_at) => {
            mint_runtime_machine_token(&space.config, request, Some(generation), expires_at)
        }
        None => mint_scoped_token_with_runtime_generation(&space.config, request, Some(generation)),
    }
    .map_err(|error| anyhow::anyhow!("failed to sign a runtime token: {error:?}"))?;
    Ok(minted.token)
}

async fn stored_generation(space: &Space, runtime_id: Uuid) -> anyhow::Result<Uuid> {
    let generation = space
        .generation(runtime_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("runtime {runtime_id} has no generation"))?;
    Ok(Uuid::parse_str(&generation)?)
}

async fn pending_mints(space: &Space, runtime_id: Uuid) -> anyhow::Result<i64> {
    sql_one(
        &space.pool,
        "select count(*) from runtime_pending_machine_mints where runtime_id = $1",
        &[&runtime_id],
    )
    .await
}

async fn runtime_rows(space: &Space, runtime_id: Uuid) -> anyhow::Result<i64> {
    sql_one(
        &space.pool,
        "select count(*) from runtimes where id = $1",
        &[&runtime_id],
    )
    .await
}

/// `POST /projects/:id/runtime/token` with `bearer`, answered in full.
async fn mint_with(
    space: &Space,
    bearer: &str,
    project_id: Uuid,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    space
        .call(
            "POST",
            &format!("/projects/{project_id}/runtime/token"),
            bearer,
            Some(body),
        )
        .await
}

/// A session of `person`, with its expiry.
fn session_of(space: &Space, person: Uuid) -> anyhow::Result<ControllerToken> {
    issue_controller_token(&space.config, &person)
        .map_err(|error| anyhow::anyhow!("failed to issue a session token: {error:?}"))
}

/// The answer to `mint`, which waits on a lock `holder` holds: `holder` lets
/// go two seconds after it sees the mint wait, and a mint that never waits
/// fails the test.
async fn mint_after_a_wait(
    space: &Space,
    holder: tokio_postgres::Transaction<'_>,
    mint: impl Future<Output = anyhow::Result<(StatusCode, JsonValue)>>,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let holder_pid: i32 = holder
        .query_one("select pg_backend_pid()", &[])
        .await?
        .get(0);
    let release = async move {
        eventually("the mint to wait on the lock", || async {
            let waiting: i64 = sql_one(
                &space.pool,
                "select count(*) from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
                &[&holder_pid],
            )
            .await?;
            Ok((waiting > 0).then_some(()))
        })
        .await?;
        tokio::time::sleep(Duration::from_secs(2)).await;
        holder.commit().await?;
        anyhow::Ok(())
    };
    let (answer, ()) = tokio::try_join!(mint, release)?;
    Ok(answer)
}

fn assert_lifetime_ended(status: StatusCode, body: &JsonValue, label: &str) {
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{label}: {body}");
    assert_eq!(
        body["code"],
        json!(RUNTIME_MACHINE_LIFETIME_ENDED_CODE),
        "{label}: {body}"
    );
}

#[tokio::test]
async fn a_machine_renews_until_its_lifetime_ends_and_is_then_told_to_mint_again(
) -> anyhow::Result<()> {
    with_space(
        "a_machine_renews_until_its_lifetime_ends_and_is_then_told_to_mint_again",
        |space| async move {
            let teammate = space.people.teammate;
            let minted_at = Utc::now().timestamp();
            let (status, body) = mint_with(
                &space,
                &space.person_token(teammate)?,
                space.project_id,
                json!({}),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "the mint: {body}");
            let token = body["token"].as_str().unwrap_or_default().to_string();
            let runtime_id = Uuid::parse_str(body["runtimeId"].as_str().unwrap_or_default())?;
            let machine_expires_at = machine_expiry(&space, &token)?
                .ok_or_else(|| anyhow::anyhow!("a person's mint carries a machine expiry"))?;
            let lifetime = machine_expires_at - minted_at;
            assert!(
                (DEFAULT_SELF_HOSTED_MACHINE_LIFETIME_SECONDS
                    ..=DEFAULT_SELF_HOSTED_MACHINE_LIFETIME_SECONDS + 60)
                    .contains(&lifetime),
                "seven days from the mint, not {lifetime} s"
            );
            let answered = DateTime::parse_from_rfc3339(
                body["machineExpiresAt"].as_str().unwrap_or_default(),
            )?;
            assert_eq!(answered.timestamp(), machine_expires_at, "{body}");

            // Every renewal carries the mint's expiry, never past it.
            let machine = space
                .registered(&token, space.project_id, runtime_id)
                .await?;
            assert_eq!(
                machine_expiry(&space, &machine.renewed)?,
                Some(machine_expires_at)
            );
            assert!(token_expiry(&space, &machine.renewed)? <= machine_expires_at);
            let machine = space
                .registered(&machine.renewed, space.project_id, runtime_id)
                .await?;
            assert_eq!(
                machine_expiry(&space, &machine.renewed)?,
                Some(machine_expires_at)
            );

            // Later in its life a renewed token would outlive the expiry:
            // registration refuses, the token itself still works.
            let generation = stored_generation(&space, runtime_id).await?;
            let late = machine_token(
                &space,
                teammate,
                space.project_id,
                runtime_id,
                generation,
                Some(Utc::now() + ChronoDuration::minutes(30)),
            )?;
            let (status, body) = space.register(&late, space.project_id, runtime_id).await?;
            assert_lifetime_ended(status, &body, "a renewal past the lifetime");
            assert_eq!(stored_generation(&space, runtime_id).await?, generation);
            let (status, body) = space.git_read(&late, space.project_id).await?;
            assert_eq!(status, StatusCode::OK, "its token still reads: {body}");

            // A mint, which checks the person again, starts a new lifetime.
            let fresh = space.start_machine(teammate, space.project_id).await?;
            assert_ne!(fresh.runtime_id, runtime_id);
            assert!(machine_expiry(&space, &fresh.renewed)? > Some(machine_expires_at - 60));
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_lifetime_is_refused_at_a_first_registration_too_and_is_configurable(
) -> anyhow::Result<()> {
    // Shorter than the hour a renewed token lives: the mint's own first
    // registration would already outlive it.
    with_configured_space(
        "a_lifetime_is_refused_at_a_first_registration_too_and_is_configurable",
        |config| config.self_hosted_machine_lifetime_seconds = 1800,
        |space| async move {
            let teammate = space.people.teammate;
            let (token, runtime_id) = space.mint(teammate, space.project_id, json!({})).await?;
            let expires_at = machine_expiry(&space, &token)?.unwrap_or_default();
            assert!(expires_at <= Utc::now().timestamp() + 1800);
            assert!(token_expiry(&space, &token)? <= expires_at);
            let (status, body) = space.register(&token, space.project_id, runtime_id).await?;
            assert_lifetime_ended(status, &body, "a first registration past the lifetime");
            assert_eq!(runtime_rows(&space, runtime_id).await?, 0);
            assert_eq!(
                pending_mints(&space, runtime_id).await?,
                1,
                "a refused registration takes no pending mint"
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_token_from_before_lifetimes_starts_one_and_a_service_runtime_has_none(
) -> anyhow::Result<()> {
    with_space(
        "a_token_from_before_lifetimes_starts_one_and_a_service_runtime_has_none",
        |space| async move {
            let teammate = space.people.teammate;
            let lifetime = space.config.self_hosted_machine_lifetime_seconds;

            // A registered machine renews on a token from before lifetimes.
            let machine = space.start_machine(teammate, space.project_id).await?;
            let generation = stored_generation(&space, machine.runtime_id).await?;
            let legacy = machine_token(
                &space,
                teammate,
                space.project_id,
                machine.runtime_id,
                generation,
                None,
            )?;
            let before = Utc::now().timestamp();
            let renewed = space
                .registered(&legacy, space.project_id, machine.runtime_id)
                .await?;
            let started = machine_expiry(&space, &renewed.renewed)?
                .ok_or_else(|| anyhow::anyhow!("the renewal starts a lifetime"))?;
            assert!((before + lifetime..=before + lifetime + 60).contains(&started));

            // A first registration on a token from before lifetimes names no
            // pending mint and is not asked for one.
            let new_runtime = Uuid::new_v4();
            let legacy = machine_token(
                &space,
                teammate,
                space.project_id,
                new_runtime,
                Uuid::new_v4(),
                None,
            )?;
            let first = space
                .registered(&legacy, space.project_id, new_runtime)
                .await?;
            assert!(machine_expiry(&space, &first.renewed)?.is_some());

            // The controller's own runtime acts for no person.
            let service_runtime = Uuid::new_v4();
            let token = space.service_runtime_token(service_runtime)?;
            let service = space
                .registered(&token, space.project_id, service_runtime)
                .await?;
            assert_eq!(machine_expiry(&space, &service.renewed)?, None);
            let (status, body) =
                mint_with(&space, SERVICE_ROLE, space.project_id, json!({})).await?;
            assert_eq!(status, StatusCode::OK, "a service mint: {body}");
            assert!(body.get("machineExpiresAt").is_none(), "{body}");
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_mint_never_outlives_the_session_that_makes_it() -> anyhow::Result<()> {
    with_space(
        "a_mint_never_outlives_the_session_that_makes_it",
        |space| async move {
            let teammate = space.people.teammate;
            // The test config's sessions last 900 s, under the hour a mint
            // would otherwise get.
            let session = session_of(&space, teammate)?;
            let (status, body) =
                mint_with(&space, &session.token, space.project_id, json!({})).await?;
            assert_eq!(status, StatusCode::OK, "the mint: {body}");
            let expires_in = body["expiresIn"].as_i64().unwrap_or_default();
            assert!((840..=900).contains(&expires_in), "{body}");
            let token = body["token"].as_str().unwrap_or_default();
            assert!(
                token_expiry(&space, token)? <= session.expires_at,
                "ends by the session's own expiry: {body}"
            );

            // Asking for longer than the session has left is refused.
            let (status, body) = mint_with(
                &space,
                &session.token,
                space.project_id,
                json!({ "ttlSeconds": 1800 }),
            )
            .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

            // Service automation's secret does not expire.
            let (status, body) =
                mint_with(&space, SERVICE_ROLE, space.project_id, json!({})).await?;
            assert_eq!(status, StatusCode::OK, "a service mint: {body}");
            assert_eq!(body["expiresIn"], json!(3600), "{body}");
            Ok(())
        },
    )
    .await?;

    with_configured_space(
        "a_mint_never_outlives_the_session_that_makes_it_nearly_expired",
        |config| config.user_token_ttl_seconds = 30,
        |space| async move {
            let teammate = space.people.teammate;
            let session = space.person_token(teammate)?;
            let (status, body) = mint_with(&space, &session, space.project_id, json!({})).await?;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
            // The CLI refreshes a session and retries on a 401 that says so.
            assert!(
                body["message"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains("expired"),
                "{body}"
            );
            let runtimes: i64 = sql_one(
                &space.pool,
                "select count(*) from runtime_pending_machine_mints where project_id = $1",
                &[&space.project_id],
            )
            .await?;
            assert_eq!(runtimes, 0, "a refused mint records nothing");
            Ok(())
        },
    )
    .await
}

/// The session's time left is measured before a mint waits on the pool, the
/// owner lock and the runtime row, so the cap must hold where it signs.
#[tokio::test]
async fn a_mint_that_waits_still_ends_by_its_session() -> anyhow::Result<()> {
    with_space(
        "a_mint_that_waits_still_ends_by_its_session",
        |space| async move {
            let teammate = space.people.teammate;
            let machine = space.start_machine(teammate, space.project_id).await?;
            let session = session_of(&space, teammate)?;
            let mut connection = space.pool.get().await?;

            // A machine mint waits on its person's owner lock while a
            // membership fence holds it.
            let fence = connection.transaction().await?;
            hold_runtime_owner_lock(&fence, teammate)
                .await
                .map_err(|error| anyhow::anyhow!("failed to hold the owner lock: {error:?}"))?;
            let (status, body) = mint_after_a_wait(
                &space,
                fence,
                mint_with(&space, &session.token, space.project_id, json!({})),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "the machine mint: {body}");
            let token = body["token"].as_str().unwrap_or_default();
            assert!(
                token_expiry(&space, token)? <= session.expires_at,
                "the machine mint ends by its session: {body}"
            );
            // The machine expiry it carries is the mint's own, not the cap.
            let answered = DateTime::parse_from_rfc3339(
                body["machineExpiresAt"].as_str().unwrap_or_default(),
            )?;
            assert_eq!(machine_expiry(&space, token)?, Some(answered.timestamp()));
            assert!(answered.timestamp() > session.expires_at, "{body}");

            // Any other mint by a person: one for its runtime's row, which
            // another transaction holds.
            let holder = connection.transaction().await?;
            holder
                .execute(
                    "select 1 from runtimes where id = $1 for update",
                    &[&machine.runtime_id],
                )
                .await?;
            let (status, body) = mint_after_a_wait(
                &space,
                holder,
                mint_with(
                    &space,
                    &session.token,
                    space.project_id,
                    json!({ "runtimeId": machine.runtime_id, "scopes": ["origin.presence"] }),
                ),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "a narrower mint: {body}");
            let token = body["token"].as_str().unwrap_or_default();
            assert_eq!(machine_expiry(&space, token)?, None, "{body}");
            assert!(
                token_expiry(&space, token)? <= session.expires_at,
                "a narrower mint ends by its session: {body}"
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_first_registration_takes_its_pending_mint_and_a_retry_still_registers(
) -> anyhow::Result<()> {
    with_space(
        "a_first_registration_takes_its_pending_mint_and_a_retry_still_registers",
        |space| async move {
            let teammate = space.people.teammate;
            let (token, runtime_id) = space.mint(teammate, space.project_id, json!({})).await?;
            let claimed: Option<String> =
                decode_scoped_token_in_full(&space.config, &token, "runtime token")
                    .map_err(|error| anyhow::anyhow!("invalid runtime token: {error:?}"))?
                    .claims
                    .runtime_generation;
            let pending: Uuid = sql_one(
                &space.pool,
                "select generation from runtime_pending_machine_mints
                 where runtime_id = $1 and project_id = $2 and owner_user_id = $3",
                &[&runtime_id, &space.project_id, &teammate],
            )
            .await?;
            assert_eq!(claimed, Some(pending.to_string()));

            space
                .registered(&token, space.project_id, runtime_id)
                .await?;
            assert_eq!(pending_mints(&space, runtime_id).await?, 0);
            assert_eq!(stored_generation(&space, runtime_id).await?, pending);
            // Its answer lost, the machine registers again on the same token.
            space
                .registered(&token, space.project_id, runtime_id)
                .await?;

            // A mint for a runtime that has a row rotates the row instead.
            let (again, minted_for) = space
                .mint(
                    teammate,
                    space.project_id,
                    json!({ "runtimeId": runtime_id }),
                )
                .await?;
            assert_eq!(minted_for, runtime_id);
            assert_eq!(pending_mints(&space, runtime_id).await?, 0);
            space
                .registered(&again, space.project_id, runtime_id)
                .await?;
            let (status, body) = space.register(&token, space.project_id, runtime_id).await?;
            assert_refused(status, &body, StatusCode::UNAUTHORIZED, "the older token");

            // A token whose pending mint never existed does not register.
            let forged_runtime = Uuid::new_v4();
            let forged = machine_token(
                &space,
                teammate,
                space.project_id,
                forged_runtime,
                Uuid::new_v4(),
                Some(Utc::now() + ChronoDuration::days(1)),
            )?;
            let (status, body) = space
                .register(&forged, space.project_id, forged_runtime)
                .await?;
            assert_refused(status, &body, StatusCode::UNAUTHORIZED, "no pending mint");
            assert_eq!(runtime_rows(&space, forged_runtime).await?, 0);
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_mint_from_before_a_removal_stays_ended_once_its_person_is_back() -> anyhow::Result<()> {
    with_space(
        "a_mint_from_before_a_removal_stays_ended_once_its_person_is_back",
        |space| async move {
            let owner = space.people.owner;
            let teammate = space.people.teammate;
            let (token, runtime_id) = space.mint(teammate, space.project_id, json!({})).await?;
            assert_eq!(pending_mints(&space, runtime_id).await?, 1);

            // Out of the team first: still the space's direct builder, so the
            // mint waits on.
            let (status, body) = space
                .call(
                    "DELETE",
                    &format!("/orgs/{}/members/{teammate}", space.org_id),
                    SERVICE_ROLE,
                    None,
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "team removal: {body}");
            assert_eq!(pending_mints(&space, runtime_id).await?, 1);

            // Then out of the space: the mint ends with their write access.
            let (status, body) = space
                .call(
                    "DELETE",
                    &format!("/projects/{}/members/{teammate}", space.project_id),
                    &space.person_token(owner)?,
                    None,
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "space removal: {body}");
            assert_eq!(pending_mints(&space, runtime_id).await?, 0);
            let (status, body) = space.register(&token, space.project_id, runtime_id).await?;
            assert_refused(status, &body, StatusCode::FORBIDDEN, "while removed");

            // A builder again, the mint from before stays ended.
            sql(
                &space.pool,
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&space.project_id, &teammate],
            )
            .await?;
            let (status, body) = space.register(&token, space.project_id, runtime_id).await?;
            assert_refused(status, &body, StatusCode::UNAUTHORIZED, "once back");
            assert_eq!(runtime_rows(&space, runtime_id).await?, 0);

            // A new mint works.
            space.start_machine(teammate, space.project_id).await?;
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_team_change_ends_pending_mints_only_where_write_access_went() -> anyhow::Result<()> {
    with_space(
        "a_team_change_ends_pending_mints_only_where_write_access_went",
        |space| async move {
            let People {
                owner, teammate, ..
            } = space.people;
            let (direct, direct_id) = space.mint(teammate, space.project_id, json!({})).await?;
            let (team_only, team_only_id) = space
                .mint(teammate, space.team_only_project_id, json!({}))
                .await?;
            let (owners, owners_id) = space
                .mint(owner, space.team_only_project_id, json!({}))
                .await?;

            // A team viewer still writes the first space as its direct builder.
            let (status, body) = space
                .call(
                    "PATCH",
                    &format!("/orgs/{}/members/{teammate}", space.org_id),
                    SERVICE_ROLE,
                    Some(json!({ "role": "viewer" })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "team downgrade: {body}");
            assert_eq!(pending_mints(&space, direct_id).await?, 1);
            assert_eq!(pending_mints(&space, team_only_id).await?, 0);
            assert_eq!(pending_mints(&space, owners_id).await?, 1);

            // A builder of the team again, the team-only mint stays ended.
            let (status, body) = space
                .call(
                    "PATCH",
                    &format!("/orgs/{}/members/{teammate}", space.org_id),
                    SERVICE_ROLE,
                    Some(json!({ "role": "builder" })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "team upgrade: {body}");
            let (status, body) = space
                .register(&team_only, space.team_only_project_id, team_only_id)
                .await?;
            assert_refused(
                status,
                &body,
                StatusCode::UNAUTHORIZED,
                "team-only first registration",
            );
            space
                .registered(&direct, space.project_id, direct_id)
                .await?;
            space
                .registered(&owners, space.team_only_project_id, owners_id)
                .await?;
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn the_retention_ticker_prunes_pending_mints_whose_tokens_expired() -> anyhow::Result<()> {
    with_space(
        "the_retention_ticker_prunes_pending_mints_whose_tokens_expired",
        |space| async move {
            assert_controller_only(&space.pool, &["runtime_pending_machine_mints"]).await?;
            let teammate = space.people.teammate;
            let long_expired = Uuid::new_v4();
            let just_expired = Uuid::new_v4();
            let live = Uuid::new_v4();
            for (runtime_id, expires_in) in [
                (long_expired, "-10 minutes"),
                (just_expired, "-1 minute"),
                (live, "1 hour"),
            ] {
                sql(
                    &space.pool,
                    "insert into runtime_pending_machine_mints
                         (runtime_id, project_id, owner_user_id, generation, expires_at)
                     values ($1, $2, $3, $4, now() + $5::text::interval)",
                    &[
                        &runtime_id,
                        &space.project_id,
                        &teammate,
                        &Uuid::new_v4(),
                        &expires_in,
                    ],
                )
                .await?;
            }
            let pruned = prune_expired_pending_machine_mints(&space.pool).await?;
            assert!(pruned >= 1, "pruned {pruned}");
            assert_eq!(pending_mints(&space, long_expired).await?, 0);
            // A token just past its expiry may still be in flight.
            assert_eq!(pending_mints(&space, just_expired).await?, 1);
            assert_eq!(pending_mints(&space, live).await?, 1);
            Ok(())
        },
    )
    .await
}
