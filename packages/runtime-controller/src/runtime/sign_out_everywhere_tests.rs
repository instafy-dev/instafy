//! Signing out everywhere (`crate::sign_out_everywhere`), on the migrated
//! database:
//! - `POST /me/sign-out-everywhere` ends every Supabase session of the
//!   person's and its refresh tokens, revokes their machines, pending mints,
//!   device grants and preview sessions, removes their push registrations,
//!   and stops their running machines;
//!   their sessions from before it are refused, one made after its answer
//!   works, and nobody else's are touched;
//! - a sign-in another controller's sign-out ended, which this controller has
//!   not heard of yet, mints no machine and logs no agent in, and signs nobody
//!   out;
//! - a mint at the same moment waits for the sign-out on the owner lock and
//!   is then refused.
//!
//! The Supabase session tables come from GoTrue, which the migrated test
//! database has run. Requires `TEST_DATABASE_URL` like the tests in
//! `tests.rs`.

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::auth::SIGNED_OUT_EVERYWHERE_CODE;
use crate::tests::{sql, sql_one};

use super::hold_runtime_owner_lock;
use super::tests::{
    assert_refused, until_waiting_or_done, with_space, Space, SELF_HOSTED, STALE_GENERATION,
};

/// `POST /me/sign-out-everywhere` with `bearer`.
async fn sign_out_everywhere(
    space: &Space,
    bearer: &str,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    space
        .call("POST", "/me/sign-out-everywhere", bearer, None)
        .await
}

fn assert_signed_out(status: StatusCode, body: &JsonValue, label: &str) {
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{label}: {body}");
    assert_eq!(
        body["code"],
        json!(SIGNED_OUT_EVERYWHERE_CODE),
        "{label}: {body}"
    );
}

/// A Supabase sign-in of `user`: its session and one refresh token, as GoTrue
/// writes them. Returns the session id.
async fn supabase_sign_in(space: &Space, user: Uuid) -> anyhow::Result<Uuid> {
    let session = Uuid::new_v4();
    sql(
        &space.pool,
        "insert into auth.sessions (id, user_id, created_at, updated_at)
         values ($1, $2, now(), now())",
        &[&session, &user],
    )
    .await?;
    sql(
        &space.pool,
        "insert into auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, session_id)
         values ($1, $2, false, now(), now(), $3)",
        &[&Uuid::new_v4().simple().to_string(), &user.to_string(), &session],
    )
    .await?;
    Ok(session)
}

/// How many Supabase sessions and refresh tokens `user` has.
async fn supabase_sign_ins(space: &Space, user: Uuid) -> anyhow::Result<(i64, i64)> {
    Ok((
        sql_one(
            &space.pool,
            "select count(*) from auth.sessions where user_id = $1",
            &[&user],
        )
        .await?,
        sql_one(
            &space.pool,
            "select count(*) from auth.refresh_tokens where user_id = $1",
            &[&user.to_string()],
        )
        .await?,
    ))
}

/// A device grant `user` gave in the first space; returns its id.
async fn device_grant(space: &Space, user: Uuid) -> anyhow::Result<Uuid> {
    let grant = Uuid::new_v4();
    sql(
        &space.pool,
        "insert into agent_device_grants
           (id, project_id, user_id, agent_id, provider_id, device_id, tool_ids, conversation_id)
         values ($1, $2, $3, $4, 'device:sign-out', 'device-1', array['device.read'], $5)",
        &[
            &grant,
            &space.project_id,
            &user,
            &Uuid::new_v4(),
            &Uuid::new_v4(),
        ],
    )
    .await?;
    Ok(grant)
}

async fn grant_revoked(space: &Space, grant: Uuid) -> anyhow::Result<bool> {
    sql_one(
        &space.pool,
        "select revoked_at is not null from agent_device_grants where id = $1",
        &[&grant],
    )
    .await
}

/// A preview viewer session of `user`'s; returns its capability hash.
async fn preview_session(space: &Space, user: Uuid) -> anyhow::Result<String> {
    let hash = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sql(
        &space.pool,
        "insert into runtime_preview_sessions (capability_hash, tunnel_id, project_id, user_id)
         values ($1, $2, $3, $4)",
        &[&hash, &Uuid::new_v4().to_string(), &space.project_id, &user],
    )
    .await?;
    Ok(hash)
}

async fn preview_revoked(space: &Space, hash: &str) -> anyhow::Result<bool> {
    sql_one(
        &space.pool,
        "select revoked_at is not null from runtime_preview_sessions where capability_hash = $1",
        &[&hash],
    )
    .await
}

/// A browser's push subscription and a phone's push token of `user`'s.
async fn push_registrations(space: &Space, user: Uuid) -> anyhow::Result<()> {
    sql(
        &space.pool,
        "insert into web_push_subscriptions (user_id, endpoint, p256dh, auth)
         values ($1, $2, 'p256dh', 'auth')",
        &[&user, &format!("https://push.example/{}", Uuid::new_v4())],
    )
    .await?;
    sql(
        &space.pool,
        "insert into native_push_tokens (user_id, platform, token) values ($1, 'ios', $2)",
        &[&user, &Uuid::new_v4().simple().to_string()],
    )
    .await?;
    Ok(())
}

async fn push_registrations_of(space: &Space, user: Uuid) -> anyhow::Result<i64> {
    sql_one(
        &space.pool,
        "select (select count(*) from web_push_subscriptions where user_id = $1)
              + (select count(*) from native_push_tokens where user_id = $1)",
        &[&user],
    )
    .await
}

/// Another controller signs `user` out everywhere: the table has it, this
/// controller's memory does not.
async fn signed_out_elsewhere(space: &Space, user: Uuid) -> anyhow::Result<()> {
    sql(
        &space.pool,
        "insert into user_sign_outs (user_id, signed_out_at) values ($1, clock_timestamp())",
        &[&user],
    )
    .await?;
    anyhow::ensure!(space.config.sign_outs.cutoff(&user).is_none());
    Ok(())
}

/// Wait until the clock is past the second of `user`'s sign-out, so a
/// session issued after is a later sign-in.
async fn after_the_sign_out(space: &Space, user: Uuid) -> anyhow::Result<()> {
    let cutoff: i64 = sql_one(
        &space.pool,
        "select floor(extract(epoch from signed_out_at))::bigint from user_sign_outs
         where user_id = $1",
        &[&user],
    )
    .await?;
    while Utc::now().timestamp() <= cutoff {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Ok(())
}

async fn pending_mints_of(space: &Space, user: Uuid) -> anyhow::Result<i64> {
    sql_one(
        &space.pool,
        "select count(*) from runtime_pending_machine_mints where owner_user_id = $1",
        &[&user],
    )
    .await
}

#[tokio::test]
async fn signing_out_everywhere_ends_every_sign_in_and_credential_of_the_person(
) -> anyhow::Result<()> {
    with_space(
        "signing_out_everywhere_ends_every_sign_in_and_credential_of_the_person",
        |space| async move {
            let (owner, teammate) = (space.people.owner, space.people.teammate);
            let machine = space.start_machine(teammate, space.project_id).await?;
            let (_, pending) = space.mint(teammate, space.project_id, json!({})).await?;
            let grant = device_grant(&space, teammate).await?;
            let preview = preview_session(&space, teammate).await?;
            push_registrations(&space, teammate).await?;
            for _ in 0..2 {
                supabase_sign_in(&space, teammate).await?;
            }
            let session = space.person_token(teammate)?;
            // The owner's sign-ins and credentials, which stay.
            let owners_machine = space.start_machine(owner, space.project_id).await?;
            let owners_grant = device_grant(&space, owner).await?;
            let owners_preview = preview_session(&space, owner).await?;
            push_registrations(&space, owner).await?;
            supabase_sign_in(&space, owner).await?;
            let owners_session = space.person_token(owner)?;

            let (status, body) = sign_out_everywhere(&space, &session).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let signed_out_at = body["signedOutAt"]
                .as_str()
                .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
                .ok_or_else(|| anyhow::anyhow!("no signedOutAt: {body}"))?;
            assert!(
                Utc::now().timestamp() > signed_out_at.timestamp(),
                "the answer waits for the second of the sign-out to pass"
            );
            assert_eq!(body["sessionsEnded"], json!(2), "{body}");
            assert_eq!(
                body["machinesRevoked"],
                json!([machine.runtime_id]),
                "{body}"
            );
            assert_eq!(body["pendingMintsEnded"], json!([pending]), "{body}");
            assert_eq!(body["deviceGrantsRevoked"], json!(1), "{body}");
            assert_eq!(body["previewSessionsRevoked"], json!(1), "{body}");
            assert_eq!(body["pushRegistrationsRemoved"], json!(2), "{body}");

            // No login of theirs refreshes again, and every credential ended.
            assert_eq!(supabase_sign_ins(&space, teammate).await?, (0, 0));
            let (status, body) = space
                .register(&machine.renewed, space.project_id, machine.runtime_id)
                .await?;
            assert_refused(status, &body, StatusCode::UNAUTHORIZED, STALE_GENERATION);
            assert_eq!(space.status(machine.runtime_id).await?, "stopped");
            assert_eq!(pending_mints_of(&space, teammate).await?, 0);
            assert!(grant_revoked(&space, grant).await?);
            assert!(preview_revoked(&space, &preview).await?);
            assert_eq!(push_registrations_of(&space, teammate).await?, 0);

            // Their session from before is refused, here and when it signs
            // out again; a sign-in after the answer works.
            let (status, body) = space.call("GET", "/me/runtimes", &session, None).await?;
            assert_signed_out(status, &body, "a session from before");
            let (status, body) = sign_out_everywhere(&space, &session).await?;
            assert_signed_out(status, &body, "signing out again with it");
            let later = space.person_token(teammate)?;
            let (status, body) = space.call("GET", "/me/runtimes", &later, None).await?;
            assert_eq!(status, StatusCode::OK, "a later sign-in: {body}");

            // Nobody else's.
            assert_eq!(supabase_sign_ins(&space, owner).await?, (1, 1));
            space
                .registered(
                    &owners_machine.renewed,
                    space.project_id,
                    owners_machine.runtime_id,
                )
                .await?;
            assert!(!grant_revoked(&space, owners_grant).await?);
            assert!(!preview_revoked(&space, &owners_preview).await?);
            assert_eq!(push_registrations_of(&space, owner).await?, 2);
            let (status, body) = space
                .call("GET", "/me/runtimes", &owners_session, None)
                .await?;
            assert_eq!(status, StatusCode::OK, "the owner's session: {body}");
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_sign_in_another_controller_ended_mints_no_machine_and_signs_nobody_out(
) -> anyhow::Result<()> {
    with_space(
        "a_sign_in_another_controller_ended_mints_no_machine_and_signs_nobody_out",
        |space| async move {
            let teammate = space.people.teammate;
            let machine = space.start_machine(teammate, space.project_id).await?;
            let ended = space.person_token(teammate)?;
            signed_out_elsewhere(&space, teammate).await?;
            after_the_sign_out(&space, teammate).await?;
            let later = space.person_token(teammate)?;
            supabase_sign_in(&space, teammate).await?;
            let runtimes: i64 = sql_one(
                &space.pool,
                "select count(*) from runtimes where project_id = $1",
                &[&space.project_id],
            )
            .await?;

            // Each asked while this controller has not heard of the sign-out:
            // the table refuses each, and teaches the controller.
            let mint = format!("/projects/{}/runtime/token", space.project_id);
            let login = json!({ "projectId": space.project_id, "runtimeType": SELF_HOSTED });
            for (label, method, uri, body) in [
                (
                    "signing out with it",
                    "POST",
                    "/me/sign-out-everywhere",
                    None,
                ),
                ("the mint", "POST", mint.as_str(), Some(json!({}))),
                ("the agent login", "POST", "/agent/login", Some(login)),
            ] {
                space.config.sign_outs.forget(&teammate);
                let (status, body) = space.call(method, uri, &ended, body).await?;
                assert_signed_out(status, &body, label);
                assert!(
                    space.config.sign_outs.cutoff(&teammate).is_some(),
                    "{label}"
                );
            }
            assert_eq!(pending_mints_of(&space, teammate).await?, 0);
            let after: i64 = sql_one(
                &space.pool,
                "select count(*) from runtimes where project_id = $1",
                &[&space.project_id],
            )
            .await?;
            assert_eq!(after, runtimes, "the refused login made no runtime");

            // The ended sign-in signed nobody out: the later one, its machine
            // and its Supabase session keep working.
            let (status, body) = space.call("GET", "/me/runtimes", &later, None).await?;
            assert_eq!(status, StatusCode::OK, "the later sign-in: {body}");
            space
                .registered(&machine.renewed, space.project_id, machine.runtime_id)
                .await?;
            assert_eq!(supabase_sign_ins(&space, teammate).await?, (1, 1));
            let (status, body) = space
                .call(
                    "POST",
                    &format!("/projects/{}/runtime/token", space.project_id),
                    &later,
                    Some(json!({})),
                )
                .await?;
            assert_eq!(
                status,
                StatusCode::OK,
                "a mint with the later sign-in: {body}"
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_mint_at_the_same_moment_waits_for_the_sign_out_and_is_refused() -> anyhow::Result<()> {
    with_space(
        "a_mint_at_the_same_moment_waits_for_the_sign_out_and_is_refused",
        |space| async move {
            let teammate = space.people.teammate;
            let session = space.person_token(teammate)?;

            // A sign-out under way: the owner lock held exclusively and its
            // moment written, not yet committed.
            let mut connection = space.pool.get().await?;
            let sign_out = connection.transaction().await?;
            hold_runtime_owner_lock(&sign_out, teammate)
                .await
                .map_err(|error| anyhow::anyhow!("owner lock: {error:?}"))?;
            sign_out
                .execute(
                    "insert into user_sign_outs (user_id, signed_out_at)
                     values ($1, clock_timestamp())",
                    &[&teammate],
                )
                .await?;

            let mint = space.spawn_call(
                "POST",
                format!("/projects/{}/runtime/token", space.project_id),
                session.clone(),
                Some(json!({})),
            );
            let login = space.spawn_call(
                "POST",
                "/agent/login".to_string(),
                session,
                Some(json!({ "projectId": space.project_id, "runtimeType": SELF_HOSTED })),
            );
            until_waiting_or_done(&space.pool, teammate, &[&mint, &login]).await?;
            assert!(!mint.is_finished(), "the mint waits for the sign-out");
            assert!(
                !login.is_finished(),
                "the agent login waits for the sign-out"
            );
            sign_out.commit().await?;
            drop(connection);
            for (label, request) in [("the mint", mint), ("the agent login", login)] {
                let (status, body) = request.await??;
                assert_signed_out(status, &body, label);
            }
            assert_eq!(pending_mints_of(&space, teammate).await?, 0);
            let runtimes: i64 = sql_one(
                &space.pool,
                "select count(*) from runtimes where project_id = $1",
                &[&space.project_id],
            )
            .await?;
            assert_eq!(runtimes, 0, "the refused login made no runtime");
            Ok(())
        },
    )
    .await
}
