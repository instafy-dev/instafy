//! What a ChatGPT device sign-in is called, and Sign in again. Every sign-in
//! used to be "ChatGPT", so a person with two plans had two connections, and
//! two agents, of that name. A second sign-in now takes the lowest free number
//! ("ChatGPT 2"). A sign-in started to replace one of the person's sign-ins
//! takes its place in the transaction that saves it when the old one is still
//! live and of the same ChatGPT account: its name, its default and its agents,
//! and the old one is retired. Of another account, or once the old one is
//! gone, it is saved as a new sign-in beside whatever is left.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use futures_util::FutureExt;
use httpmock::Method::POST;
use httpmock::MockServer;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use base64::Engine;

use super::claude_material_tests::{authorizing_issuer, complete_codex_device_login};
use super::{
    chatgpt_account_match, extract_chatgpt_account_id, local_device_auth_status_response, router,
    AccountMatch, DeviceAuthProviderState, DeviceAuthSession, DeviceAuthStatus, SignInReplacement,
    CREDENTIAL_REPLACE_UNKNOWN_CODE,
};
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
/// the connection it saved and what became of the one it replaces.
async fn finish_sign_in(
    state: &crate::AppState,
    owner: Uuid,
    issuer: &MockServer,
    replaces: Option<Uuid>,
) -> anyhow::Result<(Uuid, Option<SignInReplacement>)> {
    match complete_codex_device_login(state, owner, issuer, replaces).await? {
        DeviceAuthStatus::Completed {
            credential_id: Some(credential_id),
            replacement,
        } => Ok((credential_id, replacement)),
        other => anyhow::bail!("the device sign-in ended as {other:?}"),
    }
}

/// An ID token for the ChatGPT account `account_id` names, with the claim in
/// OpenAI's `https://api.openai.com/auth` object as OpenAI issues it (none: a
/// token that names no account).
fn id_token_for(account_id: Option<&str>) -> String {
    let claims = match account_id {
        Some(account_id) => json!({
            "sub": "inert-user",
            "https://api.openai.com/auth": { "chatgpt_account_id": account_id },
        }),
        None => json!({ "sub": "inert-user" }),
    };
    format!("e30.{}.inert", BASE64URL.encode(claims.to_string()))
}

/// An issuer that authorizes every code at once, signing in to the ChatGPT
/// account `account_id` names.
async fn issuer_for(account_id: Option<&str>) -> MockServer {
    authorizing_issuer(json!({
        "id_token": id_token_for(account_id),
        "access_token": "inert-codex-access",
        "refresh_token": "inert-codex-refresh",
    }))
    .await
}

/// A ChatGPT sign-in saved before device sign-ins stored their account in
/// metadata: the account is only in its own sealed auth.json's ID token.
/// Comes with an agent pinned to it, as every device sign-in had, by `handle`.
async fn save_older_sign_in(
    pool: &PgPool,
    state: &crate::AppState,
    owner: &Uuid,
    account_id: Option<&str>,
    is_default: bool,
    handle: &str,
) -> anyhow::Result<Uuid> {
    let auth_json = json!({
        "tokens": {
            "id_token": id_token_for(account_id),
            "access_token": "inert-older-access",
            "refresh_token": "inert-older-refresh",
        }
    });
    let keys = state
        .config
        .credential_keys
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("no credential keys"))?;
    let (nonce, ciphertext) = keys.seal(&serde_json::to_vec(&auth_json)?)?;
    let credential_id = Uuid::new_v4();
    sql(
        pool,
        "insert into user_credentials (id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default)
         values ($1, $2, 'codex_auth_json', 'ChatGPT', $3, $4, '{\"source\": \"device_code\"}'::jsonb, $5)",
        &[&credential_id, owner, &nonce, &ciphertext, &is_default],
    )
    .await?;
    sql(
        pool,
        "insert into user_agents (id, user_id, credential_id, provider, handle, display_name, avatar_seed)
         values (gen_random_uuid(), $1, $2, 'openai', $3, 'ChatGPT', 'hatchling:3')",
        &[owner, &credential_id, &handle],
    )
    .await?;
    Ok(credential_id)
}

/// An issuer whose sign-ins name no ChatGPT account.
async fn inert_issuer() -> MockServer {
    issuer_for(None).await
}

/// The handles of the person's agents that are not deleted, on a connection.
async fn agents_on(pool: &PgPool, credential_id: &Uuid) -> anyhow::Result<Vec<String>> {
    Ok(pool
        .get()
        .await?
        .query(
            "select handle from user_agents
             where credential_id = $1 and deleted_at is null order by handle",
            &[credential_id],
        )
        .await?
        .iter()
        .map(|row| row.get("handle"))
        .collect())
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
async fn a_second_sign_in_is_numbered_and_signing_in_again_keeps_the_name() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("device sign-in names").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let app = crate::credentials::router().with_state(state.clone());
        let issuer = issuer_for(Some("acct_work")).await;
        let named = |label: &str, handle: &str| {
            (
                Some(label.to_string()),
                handle.to_string(),
                Some(label.to_string()),
            )
        };

        let (first, none) = finish_sign_in(&state, owner, &issuer, None).await?;
        assert_eq!(none, None);
        assert_eq!(names(&pool, &first).await?, named("ChatGPT", "chatgpt"));
        let (second, _) = finish_sign_in(&state, owner, &issuer, None).await?;
        assert_eq!(
            names(&pool, &second).await?,
            named("ChatGPT 2", "chatgpt-2")
        );

        // Signing in again takes the name the old sign-in has then, with no
        // number.
        let (status, renamed) = call_router(
            &app,
            Some(&bearer),
            "PATCH",
            format!("/me/credentials/{second}"),
            Some(json!({ "label": "Work plan" })),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{renamed}");
        let (again, replacement) = finish_sign_in(&state, owner, &issuer, Some(second)).await?;
        assert!(
            matches!(replacement, Some(SignInReplacement::Replaced { .. })),
            "{replacement:?}"
        );
        let live = live_connections(&app, &bearer).await?;
        assert!(
            live.contains(&(again.to_string(), Some("Work plan".to_string()), false)),
            "{live:?}"
        );
        assert!(
            !live.iter().any(|(id, _, _)| *id == second.to_string()),
            "{live:?}"
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
async fn signing_in_again_to_the_same_account_replaces_the_sign_in_in_place() -> anyhow::Result<()>
{
    let pool = require_origin_test_pool("device sign-in in place").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let app = crate::credentials::router().with_state(state.clone());
        let issuer = issuer_for(Some("acct_same")).await;

        let (stale, _) = finish_sign_in(&state, owner, &issuer, None).await?;
        assert_eq!(
            live_connections(&app, &bearer).await?,
            vec![(stale.to_string(), Some("ChatGPT".to_string()), true)]
        );
        // Another agent on it, and a deleted one, which stays where it is.
        sql(
            &pool,
            "insert into user_agents (id, user_id, credential_id, provider, handle, display_name, avatar_seed, deleted_at)
             values (gen_random_uuid(), $1, $2, 'openai', 'reviewer', 'Reviewer', 'hatchling:1', null),
                    (gen_random_uuid(), $1, $2, 'openai', 'gone', 'Gone', 'hatchling:2', now())",
            &[&owner, &stale],
        )
        .await?;
        let agents = sql_one::<i64>(
            &pool,
            "select count(*) from user_agents where user_id = $1",
            &[&owner],
        )
        .await?;

        let (fresh, replacement) = finish_sign_in(&state, owner, &issuer, Some(stale)).await?;
        assert_eq!(
            replacement,
            Some(SignInReplacement::Replaced {
                id: stale,
                was_default: true
            })
        );
        // One live connection: the new one, with the old one's name and default.
        assert_eq!(
            live_connections(&app, &bearer).await?,
            vec![(fresh.to_string(), Some("ChatGPT".to_string()), true)]
        );
        // Its account is in its metadata, which Studio's account hint reads.
        assert_eq!(
            sql_one::<Option<String>>(
                &pool,
                "select metadata->>'account_id' from user_credentials where id = $1",
                &[&fresh],
            )
            .await?
            .as_deref(),
            Some("acct_same")
        );
        // Its agents are the old one's; none was made for it.
        assert_eq!(agents_on(&pool, &fresh).await?, vec!["chatgpt", "reviewer"]);
        assert_eq!(
            sql_one::<i64>(
                &pool,
                "select count(*) from user_agents where user_id = $1",
                &[&owner]
            )
            .await?,
            agents
        );
        // The old one is retired as a revoke retires one.
        let retired = pool
            .get()
            .await?
            .query_one(
                "select revoked_at is not null as revoked, is_default from user_credentials where id = $1",
                &[&stale],
            )
            .await?;
        assert!(retired.get::<_, bool>("revoked"));
        assert!(!retired.get::<_, bool>("is_default"));
        assert_eq!(
            sql_one::<i64>(
                &pool,
                "select count(*) from user_agents where credential_id = $1 and deleted_at is not null",
                &[&stale],
            )
            .await?,
            1
        );
        let (status, _) = call_router(
            &app,
            Some(&bearer),
            "DELETE",
            format!("/me/credentials/{stale}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::NOT_FOUND);
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
async fn signing_in_again_to_another_account_adds_a_connection_beside_the_old_one(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("device sign-in of another account").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let app = crate::credentials::router().with_state(state.clone());

        let (stale, _) =
            finish_sign_in(&state, owner, &issuer_for(Some("acct_a")).await, None).await?;
        let (other, replacement) = finish_sign_in(
            &state,
            owner,
            &issuer_for(Some("acct_b")).await,
            Some(stale),
        )
        .await?;
        assert_eq!(replacement, Some(SignInReplacement::DifferentAccount));
        assert_eq!(
            live_connections(&app, &bearer).await?,
            vec![
                (other.to_string(), Some("ChatGPT 2".to_string()), false),
                (stale.to_string(), Some("ChatGPT".to_string()), true),
            ]
        );
        assert_eq!(agents_on(&pool, &other).await?, vec!["chatgpt-2"]);
        assert_eq!(agents_on(&pool, &stale).await?, vec!["chatgpt"]);

        // A sign-in whose account cannot be read is never taken for the old one.
        let (unnamed, replacement) =
            finish_sign_in(&state, owner, &inert_issuer().await, Some(stale)).await?;
        assert_eq!(replacement, Some(SignInReplacement::AccountUnknown));
        assert_eq!(
            names(&pool, &unnamed).await?.0.as_deref(),
            Some("ChatGPT 3")
        );
        assert_eq!(live_connections(&app, &bearer).await?.len(), 3);
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
async fn a_sign_in_whose_old_one_was_removed_meanwhile_is_saved_as_a_new_one() -> anyhow::Result<()>
{
    let pool = require_origin_test_pool("device sign-in after a removal").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let app = crate::credentials::router().with_state(state.clone());
        let issuer = issuer_for(Some("acct_same")).await;

        let (stale, _) = finish_sign_in(&state, owner, &issuer, None).await?;
        let (status, _) = call_router(
            &app,
            Some(&bearer),
            "DELETE",
            format!("/me/credentials/{stale}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK);

        let (fresh, replacement) = finish_sign_in(&state, owner, &issuer, Some(stale)).await?;
        assert_eq!(replacement, Some(SignInReplacement::Gone));
        // A new sign-in: its own agent and the numbered name, since the
        // removed one's agent still goes by "ChatGPT".
        assert_eq!(names(&pool, &fresh).await?.0.as_deref(), Some("ChatGPT 2"));
        assert_eq!(agents_on(&pool, &fresh).await?, vec!["chatgpt-2"]);
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

#[test]
fn one_chatgpt_account_is_decided_only_on_ids_both_name() {
    assert_eq!(
        chatgpt_account_match(Some("acct_a"), Some("acct_a")),
        AccountMatch::Same
    );
    assert_eq!(
        chatgpt_account_match(Some(" acct_a "), Some("acct_a")),
        AccountMatch::Same
    );
    assert_eq!(
        chatgpt_account_match(Some("acct_a"), Some("acct_b")),
        AccountMatch::Different
    );
    // An account that cannot be read is never taken for another.
    assert_eq!(chatgpt_account_match(None, None), AccountMatch::Unknown);
    assert_eq!(
        chatgpt_account_match(Some(""), Some("")),
        AccountMatch::Unknown
    );
    assert_eq!(
        chatgpt_account_match(Some("acct_a"), None),
        AccountMatch::Unknown
    );
    assert_eq!(
        chatgpt_account_match(None, Some("acct_a")),
        AccountMatch::Unknown
    );
}

#[test]
fn the_account_is_read_from_openai_s_auth_claims_first() {
    let token = |claims: Value| format!("e30.{}.inert", BASE64URL.encode(claims.to_string()));
    assert_eq!(
        extract_chatgpt_account_id(&id_token_for(Some("acct_nested"))).as_deref(),
        Some("acct_nested")
    );
    // A top-level claim only when the auth object names none.
    assert_eq!(
        extract_chatgpt_account_id(&token(json!({ "chatgpt_account_id": "acct_top" }))).as_deref(),
        Some("acct_top")
    );
    assert_eq!(
        extract_chatgpt_account_id(&token(json!({
            "chatgpt_account_id": "acct_top",
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct_nested" },
        })))
        .as_deref(),
        Some("acct_nested")
    );
    for unknown in [
        id_token_for(None),
        token(json!({ "https://api.openai.com/auth": { "chatgpt_account_id": " " } })),
        "inert.id.token".to_string(),
        "not-a-token".to_string(),
    ] {
        assert_eq!(extract_chatgpt_account_id(&unknown), None, "{unknown}");
    }
}

#[test]
fn the_status_says_whether_a_sign_in_replaced_its_old_one() {
    let status = |replacement: Option<SignInReplacement>| {
        let session = DeviceAuthSession {
            session_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            provider: "codex".to_string(),
            verification_url: "https://auth.example.test/codex/device".to_string(),
            user_code: "INERT-CODE".to_string(),
            poll_interval_seconds: 5,
            expires_at: chrono::Utc::now(),
            status: DeviceAuthStatus::Completed {
                credential_id: Some(Uuid::nil()),
                replacement,
            },
            completed_at: None,
            provider_state: DeviceAuthProviderState::Codex {
                issuer: "https://auth.example.test".to_string(),
                client_id: "inert-client".to_string(),
                device_auth_id: "inert-device-auth".to_string(),
                replaces_credential_id: None,
            },
        };
        let body = serde_json::to_value(local_device_auth_status_response(session)).expect("json");
        (
            body["status"].clone(),
            body["replaced"].clone(),
            body["reason"].clone(),
        )
    };
    let replaced = SignInReplacement::Replaced {
        id: Uuid::new_v4(),
        was_default: false,
    };
    assert_eq!(
        status(Some(replaced)),
        (json!("completed"), json!(true), Value::Null)
    );
    assert_eq!(
        status(Some(SignInReplacement::DifferentAccount)),
        (json!("completed"), json!(false), json!("different_account"))
    );
    assert_eq!(
        status(Some(SignInReplacement::AccountUnknown)),
        (json!("completed"), json!(false), json!("account_unknown"))
    );
    assert_eq!(
        status(Some(SignInReplacement::Gone)),
        (json!("completed"), json!(false), json!("gone"))
    );
    // A sign-in that replaced nothing says nothing about it.
    assert_eq!(status(None), (json!("completed"), Value::Null, Value::Null));
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
        let (second, _) = finish_sign_in(&state, owner, &issuer, None).await?;
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
        let (third, _) = finish_sign_in(&state, owner, &issuer, None).await?;
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
        let (fourth, _) = finish_sign_in(&state, owner, &issuer, None).await?;
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
            names(&pool, &first?.0).await?.0,
            names(&pool, &second?.0).await?.0,
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

#[tokio::test]
async fn an_older_sign_in_s_account_is_read_from_its_own_auth_json() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("device sign-in of an older sign-in").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let app = crate::credentials::router().with_state(state.clone());

        // Saved before sign-ins stored their account: the same account, read
        // from the old one's own ID token, so it is replaced in place.
        let older =
            save_older_sign_in(&pool, &state, &owner, Some("acct_older"), true, "older").await?;
        let (fresh, replacement) = finish_sign_in(
            &state,
            owner,
            &issuer_for(Some("acct_older")).await,
            Some(older),
        )
        .await?;
        assert_eq!(
            replacement,
            Some(SignInReplacement::Replaced {
                id: older,
                was_default: true
            })
        );
        assert_eq!(
            live_connections(&app, &bearer).await?,
            vec![(fresh.to_string(), Some("ChatGPT".to_string()), true)]
        );
        assert_eq!(agents_on(&pool, &fresh).await?, vec!["older"]);

        // One whose own auth.json names no account is never taken for the
        // new one: the new one is added beside it.
        let unreadable =
            save_older_sign_in(&pool, &state, &owner, None, false, "unreadable").await?;
        let (beside, replacement) = finish_sign_in(
            &state,
            owner,
            &issuer_for(Some("acct_older")).await,
            Some(unreadable),
        )
        .await?;
        assert_eq!(replacement, Some(SignInReplacement::AccountUnknown));
        let live = live_connections(&app, &bearer).await?;
        assert_eq!(live.len(), 3, "{live:?}");
        assert!(live.iter().any(|(id, _, _)| *id == unreadable.to_string()));
        assert_eq!(names(&pool, &beside).await?.0.as_deref(), Some("ChatGPT 2"));
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

/// Make default reads the connection as live, then sets it in a later
/// statement. A replacement that retires it in between (held open here, as
/// the saving transaction holds it) must not end with the retired row as the
/// default and no live default left.
#[tokio::test]
async fn make_default_never_lands_on_a_connection_retired_meanwhile() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("make default during a retire").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let state = test_state(&pool);
        let bearer = bearer_for(&state, &owner)?;
        let app = crate::credentials::router().with_state(state.clone());
        let default = connect(
            &app,
            &bearer,
            json!({
                "authJson": { "OPENAI_API_KEY": "inert-api-key" },
                "provider": "openai",
                "label": "OpenAI",
            }),
        )
        .await?;
        let (retiring, _) =
            finish_sign_in(&state, owner, &issuer_for(Some("acct_same")).await, None).await?;

        let mut holder = pool.get().await?;
        let retire = holder.transaction().await?;
        retire
            .query(
                "select 1 from user_credentials where id = $1 for no key update",
                &[&retiring],
            )
            .await?;
        retire
            .execute(
                "update user_credentials set revoked_at = now(), is_default = false
                 where id = $1",
                &[&retiring],
            )
            .await?;
        let watch = pool.clone();
        let release = async move {
            let waiting = eventually("Make default to wait", || async {
                let waiting = sql_one::<i64>(
                    &watch,
                    "select count(*) from pg_stat_activity
                     where datname = current_database() and wait_event_type = 'Lock'",
                    &[],
                )
                .await?;
                Ok((waiting >= 1).then_some(()))
            })
            .await;
            retire.commit().await?;
            waiting
        };
        let (made, released) = tokio::join!(
            call_router(
                &app,
                Some(&bearer),
                "POST",
                format!("/me/credentials/{retiring}/default"),
                None,
            ),
            release,
        );
        released?;
        let (status, body) = made?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["message"], json!("credential not found"));
        // The default stays where it was, and the retired row is not it.
        let defaults = pool
            .get()
            .await?
            .query(
                "select id from user_credentials where user_id = $1 and is_default",
                &[&owner],
            )
            .await?
            .iter()
            .map(|row| row.get::<_, Uuid>("id"))
            .collect::<Vec<_>>();
        assert_eq!(defaults, vec![default]);
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
