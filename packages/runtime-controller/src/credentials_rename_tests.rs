//! Names for sign-ins: a person renames their own connections, and the agent
//! made for a connection keeps going by its name. A connection's name is that
//! agent's display name and its handle is made from it, and teammates see
//! both, so no name, typed or renamed, holds an email address.

use axum::http::StatusCode;
use futures_util::FutureExt;
use serde_json::{json, Value};
use uuid::Uuid;

use super::session_identity_tests::{scoped_token_for, supabase_access_token};
use crate::credential_labels::{
    CREDENTIAL_LABEL_HAS_EMAIL_CODE, CREDENTIAL_LABEL_HAS_EMAIL_MESSAGE,
    CREDENTIAL_LABEL_INVALID_CODE,
};
use crate::tests::{
    build_app_config, build_test_state, call_router, ensure_test_user, require_origin_test_pool,
    sql, sql_one, test_origin_private_key, test_origin_public_key,
};

fn test_config() -> crate::AppConfig {
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "credential-rename",
    );
    config.credential_keys =
        Some(crate::config::CredentialEncryptionKey::for_test("credential-rename-test-key").into());
    config
}

fn bearer_for(config: &crate::AppConfig, user_id: &Uuid) -> anyhow::Result<String> {
    crate::auth::issue_controller_token(config, user_id)
        .map(|issued| format!("Bearer {}", issued.token))
        .map_err(|(_, error)| anyhow::anyhow!(error.0.message))
}

fn codex_login(label: &str) -> Value {
    json!({
        "authJson": {
            "tokens": { "access_token": "fixture-access-token", "account_id": "acct_fixture" }
        },
        "label": label,
    })
}

/// The agent's handle and display name, by id.
async fn agent_names(
    pool: &crate::config::PgPool,
    agent_id: &Uuid,
) -> anyhow::Result<(String, Option<String>)> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select handle, display_name from user_agents where id = $1",
            &[agent_id],
        )
        .await?;
    Ok((row.get("handle"), row.get("display_name")))
}

async fn insert_agent(
    pool: &crate::config::PgPool,
    user_id: &Uuid,
    credential_id: Option<&Uuid>,
    handle: &str,
    display_name: &str,
    deleted: bool,
) -> anyhow::Result<Uuid> {
    let agent_id = Uuid::new_v4();
    sql(
        pool,
        "insert into user_agents (id, user_id, credential_id, provider, handle, display_name, avatar_seed, deleted_at)
         values ($1, $2, $3, 'openai', $4, $5, 'hatchling:1', case when $6 then now() end)",
        &[&agent_id, user_id, &credential_id, &handle, &display_name, &deleted],
    )
    .await?;
    Ok(agent_id)
}

async fn rename(
    app: &axum::Router,
    bearer: &str,
    credential_id: &str,
    body: Value,
) -> anyhow::Result<(StatusCode, Value)> {
    call_router(
        app,
        Some(bearer),
        "PATCH",
        format!("/me/credentials/{credential_id}"),
        Some(body),
    )
    .await
}

#[tokio::test]
async fn a_rename_reaches_the_agents_still_named_after_the_connection() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("credential rename route").await?;
    let owner = Uuid::new_v4();
    let teammate = Uuid::new_v4();
    let users = vec![owner, teammate];

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        ensure_test_user(&pool, &teammate).await?;
        let config = test_config();
        let owner_bearer = bearer_for(&config, &owner)?;
        let teammate_bearer = bearer_for(&config, &teammate)?;
        let app = super::router().with_state(build_test_state(pool.clone(), config.clone()));

        let (status, created) = call_router(
            &app,
            Some(&owner_bearer),
            "POST",
            "/me/credentials/codex".to_string(),
            Some(codex_login("ChatGPT")),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{created}");
        let credential_id = created["credentialId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let credential_uuid: Uuid = credential_id.parse()?;
        let made_agent: Uuid = created["agentId"].as_str().unwrap_or_default().parse()?;
        assert_eq!(
            agent_names(&pool, &made_agent).await?,
            ("chatgpt".to_string(), Some("ChatGPT".to_string()))
        );
        // Agents that do not go by the connection's name, or are not its.
        let named_by_owner = insert_agent(
            &pool,
            &owner,
            Some(&credential_uuid),
            "reviewer",
            "Reviewer",
            false,
        )
        .await?;
        let on_no_connection =
            insert_agent(&pool, &owner, None, "chatgpt-solo", "ChatGPT", false).await?;
        let deleted = insert_agent(
            &pool,
            &owner,
            Some(&credential_uuid),
            "old",
            "ChatGPT",
            true,
        )
        .await?;

        let (status, renamed) = rename(
            &app,
            &owner_bearer,
            &credential_id,
            json!({ "label": "  Work plan  " }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{renamed}");
        assert_eq!(renamed["label"], json!("Work plan"), "{renamed}");
        // The answer is the item exactly as the list shows it.
        let (_, listed) = call_router(
            &app,
            Some(&owner_bearer),
            "GET",
            "/me/credentials".to_string(),
            None,
        )
        .await?;
        let listed = listed
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == json!(credential_id)))
            .cloned()
            .unwrap_or(Value::Null);
        assert_eq!(renamed, listed);

        // The agent still named after the connection follows; its handle,
        // which people mention, stays.
        assert_eq!(
            agent_names(&pool, &made_agent).await?,
            ("chatgpt".to_string(), Some("Work plan".to_string()))
        );
        assert_eq!(
            agent_names(&pool, &named_by_owner).await?.1.as_deref(),
            Some("Reviewer")
        );
        assert_eq!(
            agent_names(&pool, &on_no_connection).await?.1.as_deref(),
            Some("ChatGPT")
        );
        assert_eq!(
            agent_names(&pool, &deleted).await?.1.as_deref(),
            Some("ChatGPT")
        );

        // An agent renamed by hand is no longer the connection's name.
        sql(
            &pool,
            "update user_agents set display_name = 'Planner' where id = $1",
            &[&made_agent],
        )
        .await?;
        let (status, _) = rename(
            &app,
            &owner_bearer,
            &credential_id,
            json!({ "label": "Team plan" }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            agent_names(&pool, &made_agent).await?.1.as_deref(),
            Some("Planner")
        );

        // Names a person may not give.
        for (label, code) in [
            (json!("ann@example.com"), CREDENTIAL_LABEL_HAS_EMAIL_CODE),
            (
                json!("Work (ann.lee@corp.co.uk)"),
                CREDENTIAL_LABEL_HAS_EMAIL_CODE,
            ),
            (json!("   "), CREDENTIAL_LABEL_INVALID_CODE),
            (json!("a".repeat(61)), CREDENTIAL_LABEL_INVALID_CODE),
            (json!("Work\nplan"), CREDENTIAL_LABEL_INVALID_CODE),
            (Value::Null, CREDENTIAL_LABEL_INVALID_CODE),
        ] {
            let (status, refused) = rename(
                &app,
                &owner_bearer,
                &credential_id,
                json!({ "label": label }),
            )
            .await?;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {refused}");
            assert_eq!(refused["code"], json!(code), "{label}: {refused}");
        }
        let (status, refused) = rename(&app, &owner_bearer, &credential_id, json!({})).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["code"], json!(CREDENTIAL_LABEL_INVALID_CODE));
        let (_, refused) = rename(
            &app,
            &owner_bearer,
            &credential_id,
            json!({ "label": "ann@example.com" }),
        )
        .await?;
        assert_eq!(
            refused["message"],
            json!(CREDENTIAL_LABEL_HAS_EMAIL_MESSAGE)
        );

        // Only the owner, through their own session.
        let (status, refused) = rename(
            &app,
            &teammate_bearer,
            &credential_id,
            json!({ "label": "Mine now" }),
        )
        .await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{refused}");
        for (who, token) in [
            ("service role", supabase_access_token(owner, "service_role")),
            ("runtime token", scoped_token_for(&config, owner)),
        ] {
            let (status, refused) = rename(
                &app,
                &format!("Bearer {token}"),
                &credential_id,
                json!({ "label": "Mine now" }),
            )
            .await?;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{who}: {refused}");
            assert_eq!(
                refused["message"],
                json!("interactive user session required"),
                "{who}"
            );
        }
        let reserved = crate::config::managed_ai_credential_id().to_string();
        for unknown in [reserved, Uuid::new_v4().to_string()] {
            let (status, refused) = rename(
                &app,
                &owner_bearer,
                &unknown,
                json!({ "label": "Mine now" }),
            )
            .await?;
            assert_eq!(status, StatusCode::NOT_FOUND, "{unknown}: {refused}");
        }
        assert_eq!(
            sql_one::<Option<String>>(
                &pool,
                "select label from user_credentials where id = $1",
                &[&credential_uuid],
            )
            .await?
            .as_deref(),
            Some("Team plan")
        );

        // A revoked connection is no longer one to rename.
        let (status, _) = call_router(
            &app,
            Some(&owner_bearer),
            "DELETE",
            format!("/me/credentials/{credential_id}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK);
        let (status, refused) = rename(
            &app,
            &owner_bearer,
            &credential_id,
            json!({ "label": "Revived" }),
        )
        .await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{refused}");
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = async {
        sql(
            &pool,
            "delete from user_agents where user_id = any($1)",
            &[&users],
        )
        .await?;
        sql(
            &pool,
            "delete from user_credentials where user_id = any($1)",
            &[&users],
        )
        .await?;
        sql(
            &pool,
            "delete from auth.users where id = any($1)",
            &[&users],
        )
        .await?;
        anyhow::Ok(())
    }
    .await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[tokio::test]
async fn a_typed_name_follows_the_rename_rules() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("typed credential label").await?;
    let owner = Uuid::new_v4();

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &owner).await?;
        let config = test_config();
        let bearer = bearer_for(&config, &owner)?;
        let app = super::router().with_state(build_test_state(pool.clone(), config));
        let connect = |body: Value| {
            call_router(
                &app,
                Some(&bearer),
                "POST",
                "/me/credentials/codex".to_string(),
                Some(body),
            )
        };

        for (label, code) in [
            ("ann@example.com", CREDENTIAL_LABEL_HAS_EMAIL_CODE),
            ("Codex for ann@example.com", CREDENTIAL_LABEL_HAS_EMAIL_CODE),
            ("Two\nlines", CREDENTIAL_LABEL_INVALID_CODE),
        ] {
            let (status, refused) = connect(codex_login(label)).await?;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {refused}");
            assert_eq!(refused["code"], json!(code), "{label}");
        }
        let (status, refused) = connect(codex_login(&"a".repeat(61))).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["code"], json!(CREDENTIAL_LABEL_INVALID_CODE));
        // Nothing was stored, and no agent was made from a refused name.
        assert_eq!(
            sql_one::<i64>(
                &pool,
                "select count(*) from user_credentials where user_id = $1",
                &[&owner],
            )
            .await?,
            0
        );

        // A name that follows them is saved trimmed, and none leaves the
        // connection unnamed, as before.
        let (status, created) = connect(codex_login("  Codex on this computer ")).await?;
        assert_eq!(status, StatusCode::OK, "{created}");
        let (status, unnamed) = connect(codex_login("   ")).await?;
        assert_eq!(status, StatusCode::OK, "{unnamed}");
        let labels = pool
            .get()
            .await?
            .query(
                "select label from user_credentials where user_id = $1 order by created_at",
                &[&owner],
            )
            .await?
            .iter()
            .map(|row| row.get::<_, Option<String>>("label"))
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            vec![Some("Codex on this computer".to_string()), None]
        );
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = async {
        sql(
            &pool,
            "delete from user_agents where user_id = $1",
            &[&owner],
        )
        .await?;
        sql(
            &pool,
            "delete from user_credentials where user_id = $1",
            &[&owner],
        )
        .await?;
        sql(&pool, "delete from auth.users where id = $1", &[&owner]).await?;
        anyhow::Ok(())
    }
    .await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
