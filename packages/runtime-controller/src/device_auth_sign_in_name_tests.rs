//! What a ChatGPT device sign-in is called. Every one used to be "ChatGPT",
//! so a person with two plans had two connections, and two agents, of that
//! name. A second sign-in now takes the lowest free number ("ChatGPT 2"), and
//! a sign-in that replaces one of the person's sign-ins takes that one's name
//! as it is when the new one is saved. Studio saves a replacement before it
//! retires the old sign-in, so numbering alone would call a reconnected
//! "ChatGPT" "ChatGPT 2".

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use futures_util::FutureExt;
use httpmock::Method::POST;
use httpmock::MockServer;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use super::claude_material_tests::{authorizing_issuer, complete_codex_device_login};
use super::{router, DeviceAuthProviderState, DeviceAuthStatus, CREDENTIAL_REPLACE_UNKNOWN_CODE};
use crate::config::{CredentialEncryptionKey, PgPool};
use crate::credentials::claude_material_tests::EnvVarGuard;
use crate::tests::{
    build_app_config, build_test_state, call_router, ensure_test_user, eventually,
    require_origin_test_pool, sql, sql_one, test_origin_private_key, test_origin_public_key,
};

fn test_state(pool: &PgPool) -> crate::AppState {
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "device-sign-in-names",
    );
    config.credential_keys = Some(CredentialEncryptionKey::for_test("device sign-in names").into());
    build_test_state(pool.clone(), config)
}

fn bearer_for(state: &crate::AppState, user_id: &Uuid) -> anyhow::Result<String> {
    crate::auth::issue_controller_token(&state.config, user_id)
        .map(|issued| format!("Bearer {}", issued.token))
        .map_err(|(_, error)| anyhow::anyhow!(error.0.message))
}

/// Saves a connection for the person behind `bearer` and gives its id.
async fn connect(app: &axum::Router, bearer: &str, body: Value) -> anyhow::Result<Uuid> {
    let (status, created) = call_router(
        app,
        Some(bearer),
        "POST",
        "/me/credentials/codex".to_string(),
        Some(body),
    )
    .await?;
    anyhow::ensure!(status == StatusCode::OK, "{status}: {created}");
    Ok(created["credentialId"]
        .as_str()
        .unwrap_or_default()
        .parse()?)
}

/// The connection's name, and the handle and display name of the agent made
/// for it.
async fn names(
    pool: &PgPool,
    credential_id: &Uuid,
) -> anyhow::Result<(Option<String>, String, Option<String>)> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select c.label, a.handle, a.display_name
             from user_credentials c
             join user_agents a on a.credential_id = c.id and a.deleted_at is null
             where c.id = $1",
            &[credential_id],
        )
        .await?;
    Ok((row.get("label"), row.get("handle"), row.get("display_name")))
}

/// Runs a ChatGPT device sign-in for `owner` to its end and gives the id of
/// the connection it saved.
async fn finish_sign_in(
    state: &crate::AppState,
    owner: Uuid,
    issuer: &MockServer,
    replaces: Option<Uuid>,
) -> anyhow::Result<Uuid> {
    match complete_codex_device_login(state, owner, issuer, replaces).await? {
        DeviceAuthStatus::Completed {
            credential_id: Some(credential_id),
        } => Ok(credential_id),
        other => anyhow::bail!("the device sign-in ended as {other:?}"),
    }
}

/// An issuer that authorizes every code at once with inert tokens.
async fn inert_issuer() -> MockServer {
    authorizing_issuer(json!({
        "id_token": "inert.id.token",
        "access_token": "inert-codex-access",
        "refresh_token": "inert-codex-refresh",
    }))
    .await
}

/// The person's live connections as `GET /me/credentials` lists them:
/// id, name and whether it is the default.
async fn live_connections(
    app: &axum::Router,
    bearer: &str,
) -> anyhow::Result<Vec<(String, Option<String>, bool)>> {
    let (status, listed) = call_router(
        app,
        Some(bearer),
        "GET",
        "/me/credentials".to_string(),
        None,
    )
    .await?;
    anyhow::ensure!(status == StatusCode::OK, "{status}: {listed}");
    Ok(listed
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|item| item["revokedAt"].is_null())
        .map(|item| {
            (
                item["id"].as_str().unwrap_or_default().to_string(),
                item["label"].as_str().map(str::to_string),
                item["isDefault"] == json!(true),
            )
        })
        .collect())
}

async fn delete_users(pool: &PgPool, users: &[Uuid]) -> anyhow::Result<()> {
    let users = users.to_vec();
    sql(
        pool,
        "delete from user_agents where user_id = any($1)",
        &[&users],
    )
    .await?;
    sql(
        pool,
        "delete from user_credentials where user_id = any($1)",
        &[&users],
    )
    .await?;
    sql(pool, "delete from auth.users where id = any($1)", &[&users]).await?;
    Ok(())
}

#[tokio::test]
async fn a_second_sign_in_is_numbered_and_a_reconnect_keeps_its_name() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("device sign-in names").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let app = crate::credentials::router().with_state(state.clone());
        let issuer = authorizing_issuer(json!({
            "id_token": "inert.id.token",
            "access_token": "inert-codex-access",
            "refresh_token": "inert-codex-refresh",
        }))
        .await;
        let sign_in = |replaces: Option<Uuid>| {
            let state = state.clone();
            let issuer = &issuer;
            async move {
                match complete_codex_device_login(&state, owner, issuer, replaces).await? {
                    DeviceAuthStatus::Completed {
                        credential_id: Some(credential_id),
                    } => anyhow::Ok(credential_id),
                    other => anyhow::bail!("the device sign-in ended as {other:?}"),
                }
            }
        };
        let named = |label: &str, handle: &str| {
            (
                Some(label.to_string()),
                handle.to_string(),
                Some(label.to_string()),
            )
        };

        let first = sign_in(None).await?;
        assert_eq!(names(&pool, &first).await?, named("ChatGPT", "chatgpt"));
        let second = sign_in(None).await?;
        assert_eq!(
            names(&pool, &second).await?,
            named("ChatGPT 2", "chatgpt-2")
        );

        // A reconnect of the first, which Studio retires only afterwards.
        let reconnected = sign_in(Some(first)).await?;
        assert_eq!(
            names(&pool, &reconnected).await?,
            named("ChatGPT", "chatgpt-3")
        );

        // Once the replaced sign-in is revoked, there is no name to keep.
        let (status, _) = call_router(
            &app,
            Some(&bearer),
            "DELETE",
            format!("/me/credentials/{first}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        let late = sign_in(Some(first)).await?;
        assert_eq!(names(&pool, &late).await?.0.as_deref(), Some("ChatGPT 3"));

        // The replaced sign-in's name as it is now, with no number.
        let (status, renamed) = call_router(
            &app,
            Some(&bearer),
            "PATCH",
            format!("/me/credentials/{second}"),
            Some(json!({ "label": "Work plan" })),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{renamed}");
        let work = sign_in(Some(second)).await?;
        assert_eq!(names(&pool, &work).await?.0.as_deref(), Some("Work plan"));

        // A replaced connection with no name leaves the lowest free number,
        // which the rename above gave back.
        let unnamed = connect(
            &app,
            &bearer,
            json!({ "authJson": { "tokens": { "access_token": "inert-upload-access" } } }),
        )
        .await?;
        assert_eq!(names(&pool, &unnamed).await?.0, None);
        let after_unnamed = sign_in(Some(unnamed)).await?;
        assert_eq!(
            names(&pool, &after_unnamed).await?.0.as_deref(),
            Some("ChatGPT 2")
        );
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = delete_users(&pool, &[owner]).await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[tokio::test]
async fn a_start_replaces_only_a_live_chatgpt_sign_in_of_the_person() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("device sign-in replacement").await?;
    let owner = Uuid::new_v4();
    let teammate = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        ensure_test_user(&pool, &teammate).await?;
        // A local issuer that hands out codes and is never authorized, so no
        // sign-in started here finishes.
        let issuer = MockServer::start_async().await;
        let usercode = issuer
            .mock_async(|when, then| {
                when.method(POST).path("/api/accounts/deviceauth/usercode");
                then.status(200).json_body(json!({
                    "device_auth_id": "inert-device-auth",
                    "user_code": "INERT-CODE",
                    "interval": 5,
                }));
            })
            .await;
        issuer
            .mock_async(|when, then| {
                when.method(POST).path("/api/accounts/deviceauth/token");
                then.status(403);
            })
            .await;
        let _issuer = EnvVarGuard::set("CODEX_DEVICE_AUTH_ISSUER", &issuer.base_url());
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let teammate_bearer = bearer_for(&state, &teammate)?;
        let app = crate::credentials::router()
            .merge(router())
            .with_state(state.clone());
        let start = |provider: &'static str, body: Option<Value>| {
            call_router(
                &app,
                Some(&bearer),
                "POST",
                format!("/me/auth/device/{provider}/start"),
                body,
            )
        };
        let replaced_by = |session: &Value| {
            let state = state.clone();
            let session_id = session["sessionId"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            async move {
                let session = state
                    .device_auth_sessions
                    .get(&session_id.parse()?)
                    .await
                    .ok_or_else(|| anyhow::anyhow!("no session {session_id}"))?;
                match session.provider_state {
                    DeviceAuthProviderState::Codex {
                        replaces_credential_id,
                        ..
                    } => anyhow::Ok(replaces_credential_id),
                    DeviceAuthProviderState::Github { .. } => {
                        anyhow::bail!("a ChatGPT start made a GitHub session")
                    }
                }
            }
        };

        let chatgpt_login = json!({ "authJson": { "tokens": { "access_token": "inert-access" } } });
        let live = connect(&app, &bearer, chatgpt_login.clone()).await?;
        let api_key = connect(
            &app,
            &bearer,
            json!({ "authJson": { "OPENAI_API_KEY": "inert-api-key" }, "provider": "openai" }),
        )
        .await?;
        let revoked = connect(&app, &bearer, chatgpt_login.clone()).await?;
        let (status, _) = call_router(
            &app,
            Some(&bearer),
            "DELETE",
            format!("/me/credentials/{revoked}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        let teammates = connect(&app, &teammate_bearer, chatgpt_login).await?;

        let (status, session) = start(
            "codex",
            Some(json!({ "replacesCredentialId": live.to_string() })),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{session}");
        assert_eq!(replaced_by(&session).await?, Some(live));
        // Without a body, or with nothing to replace, it starts as before.
        for body in [
            None,
            Some(Value::Null),
            Some(json!({})),
            Some(json!({ "replacesCredentialId": null })),
        ] {
            let (status, session) = start("codex", body.clone()).await?;
            assert_eq!(status, StatusCode::OK, "{body:?}: {session}");
            assert_eq!(replaced_by(&session).await?, None, "{body:?}");
        }
        let started = usercode.hits_async().await;

        for refused in [
            api_key.to_string(),
            revoked.to_string(),
            teammates.to_string(),
            crate::config::managed_ai_credential_id().to_string(),
            Uuid::new_v4().to_string(),
            "not-a-uuid".to_string(),
        ] {
            let (status, body) =
                start("codex", Some(json!({ "replacesCredentialId": refused }))).await?;
            assert_eq!(
                status,
                StatusCode::UNPROCESSABLE_ENTITY,
                "{refused}: {body}"
            );
            assert_eq!(
                body["code"],
                json!(CREDENTIAL_REPLACE_UNKNOWN_CODE),
                "{refused}"
            );
        }
        // GitHub's sign-in replaces no connection.
        let (status, body) = start(
            "github",
            Some(json!({ "replacesCredentialId": live.to_string() })),
        )
        .await?;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["code"], json!(CREDENTIAL_REPLACE_UNKNOWN_CODE));
        // A body that is not JSON is refused as one.
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/me/auth/device/codex/start")
                    .header("authorization", &bearer)
                    .header("content-type", "application/json")
                    .body(Body::from("{"))?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let _ = to_bytes(response.into_body(), 64 * 1024).await?;
        // No refused start asked OpenAI for a code.
        assert_eq!(usercode.hits_async().await, started);
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = delete_users(&pool, &[owner, teammate]).await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[tokio::test]
async fn signing_in_again_leaves_one_connection_of_the_name() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("device sign-in again").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let app = crate::credentials::router().with_state(state.clone());
        let issuer = inert_issuer().await;

        let stale = finish_sign_in(&state, owner, &issuer, None).await?;
        assert_eq!(
            live_connections(&app, &bearer).await?,
            vec![(stale.to_string(), Some("ChatGPT".to_string()), true)]
        );

        // Studio's Sign in again: the new sign-in names the one it replaces,
        // then Studio makes it the default, as the old one was, and retires
        // the old one (`finalizeCredentialReplacement`).
        let fresh = finish_sign_in(&state, owner, &issuer, Some(stale)).await?;
        let (status, promoted) = call_router(
            &app,
            Some(&bearer),
            "POST",
            format!("/me/credentials/{fresh}/default"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{promoted}");
        let (status, retired) = call_router(
            &app,
            Some(&bearer),
            "DELETE",
            format!("/me/credentials/{stale}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{retired}");

        assert_eq!(
            live_connections(&app, &bearer).await?,
            vec![(fresh.to_string(), Some("ChatGPT".to_string()), true)]
        );
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = delete_users(&pool, &[owner]).await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[tokio::test]
async fn a_removed_sign_in_s_agent_keeps_its_number_taken() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("device sign-in numbers and agents").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let app = crate::credentials::router().with_state(state.clone());
        let issuer = inert_issuer().await;
        let agents_named = |name: &'static str| {
            let pool = pool.clone();
            async move {
                sql_one::<i64>(
                    &pool,
                    "select count(*) from user_agents
                     where user_id = $1 and deleted_at is null and display_name = $2",
                    &[&owner, &name],
                )
                .await
            }
        };

        finish_sign_in(&state, owner, &issuer, None).await?;
        let second = finish_sign_in(&state, owner, &issuer, None).await?;
        assert_eq!(names(&pool, &second).await?.0.as_deref(), Some("ChatGPT 2"));

        // Removing the connection leaves its agent, still named "ChatGPT 2",
        // so the next sign-in takes another number.
        let (status, _) = call_router(
            &app,
            Some(&bearer),
            "DELETE",
            format!("/me/credentials/{second}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        let third = finish_sign_in(&state, owner, &issuer, None).await?;
        assert_eq!(names(&pool, &third).await?.0.as_deref(), Some("ChatGPT 3"));
        assert_eq!(agents_named("ChatGPT 2").await?, 1);

        // A deleted agent no longer holds its name.
        sql(
            &pool,
            "update user_agents set deleted_at = now()
             where user_id = $1 and display_name = 'ChatGPT 2'",
            &[&owner],
        )
        .await?;
        let fourth = finish_sign_in(&state, owner, &issuer, None).await?;
        assert_eq!(names(&pool, &fourth).await?.0.as_deref(), Some("ChatGPT 2"));
        assert_eq!(agents_named("ChatGPT 2").await?, 1);
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = delete_users(&pool, &[owner]).await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// Two sign-ins of one person that finish at the same moment. The test holds
/// the person's `auth.users` row, which saving a connection waits on for its
/// foreign key, until both saves are waiting; without the lock on the
/// person's connection names both would read the names before either is
/// saved and both take "ChatGPT".
#[tokio::test]
async fn two_sign_ins_that_finish_together_take_different_names() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("device sign-ins finishing together").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let app = crate::credentials::router().with_state(state.clone());
        // A default already, so neither new connection competes to be it.
        connect(
            &app,
            &bearer,
            json!({
                "authJson": { "OPENAI_API_KEY": "inert-api-key" },
                "provider": "openai",
                "label": "OpenAI",
            }),
        )
        .await?;
        let issuer = inert_issuer().await;

        let mut holder = pool.get().await?;
        let hold = holder.transaction().await?;
        hold.query(
            "select 1 from auth.users where id = $1 for update",
            &[&owner],
        )
        .await?;
        let watch = pool.clone();
        let release = async move {
            // Both saves wait: the first on the held row, the second on the
            // first (or, without the lock, on the held row too).
            let waiting = eventually("both saves to wait", || async {
                let waiting = sql_one::<i64>(
                    &watch,
                    "select count(*) from pg_stat_activity
                     where datname = current_database() and wait_event_type = 'Lock'",
                    &[],
                )
                .await?;
                Ok((waiting >= 2).then_some(()))
            })
            .await;
            hold.commit().await?;
            waiting
        };
        let (first, second, released) = tokio::join!(
            finish_sign_in(&state, owner, &issuer, None),
            finish_sign_in(&state, owner, &issuer, None),
            release,
        );
        released?;
        let mut taken = vec![
            names(&pool, &first?).await?.0,
            names(&pool, &second?).await?.0,
        ];
        taken.sort();
        assert_eq!(
            taken,
            vec![Some("ChatGPT".to_string()), Some("ChatGPT 2".to_string())]
        );
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = delete_users(&pool, &[owner]).await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
