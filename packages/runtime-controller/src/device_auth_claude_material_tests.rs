//! Device login and the credential guard (docs/Local-Engine-Turns.md,
//! section 6). Its providers stay `codex` and `github`: Claude Code signs in
//! through Anthropic's own login on the person's computer, never through
//! Instafy. A Codex device login that comes back with Claude tokens reaches
//! `insert_user_credential` like any other and stores nothing.

use std::time::Duration;

use axum::http::StatusCode;
use bb8_postgres::PostgresConnectionManager;
use chrono::{Duration as ChronoDuration, Utc};
use futures_util::FutureExt;
use httpmock::Method::POST;
use httpmock::MockServer;
use serde_json::{json, Value};
use uuid::Uuid;

use super::{
    poll_codex_device_auth, router, DeviceAuthProviderState, DeviceAuthSession, DeviceAuthStatus,
    CODEX_DEVICE_AUTH_UNAVAILABLE_MESSAGE, GITHUB_DEVICE_AUTH_STORAGE_UNAVAILABLE_MESSAGE,
};
use crate::claude_material::CLAUDE_CREDENTIAL_REFUSED_MESSAGE;
use crate::config::CredentialEncryptionKey;
use crate::credentials::claude_material_tests::{EnvVarGuard, OAUTH_ACCESS, OAUTH_REFRESH};
use crate::tests::{
    build_app_config, build_test_state, call_router, ensure_test_user, require_origin_test_pool,
    sql, sql_one, test_origin_private_key, test_origin_public_key,
};

fn test_config() -> crate::AppConfig {
    build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "device-auth-claude-material",
    )
}

#[tokio::test]
async fn device_login_providers_stay_codex_and_github() -> anyhow::Result<()> {
    // Codex's issuer is a local recorder without a device-code endpoint, so a
    // start never leaves this machine, and GitHub stops at the missing
    // credential key. Both answer as providers, with their own setup errors,
    // before any database access: nothing listens on port 1.
    let issuer = MockServer::start_async().await;
    let usercode = issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/usercode");
            then.status(404);
        })
        .await;
    let _issuer = EnvVarGuard::set("CODEX_DEVICE_AUTH_ISSUER", &issuer.base_url());
    let manager = PostgresConnectionManager::new_from_stringlike(
        "postgresql://postgres:postgres@127.0.0.1:1/postgres",
        crate::config::database_tls(),
    )?;
    let pool = bb8::Pool::builder()
        .max_size(1)
        .connection_timeout(Duration::from_millis(500))
        .build_unchecked(manager);
    let config = test_config();
    let bearer = crate::auth::issue_controller_token(&config, &Uuid::new_v4())
        .map(|issued| format!("Bearer {}", issued.token))
        .map_err(|(status, error)| anyhow::anyhow!("{status}: {}", error.0.message))?;
    let app = router().with_state(build_test_state(pool, config));
    let start = |provider: &str| {
        call_router(
            &app,
            Some(&bearer),
            "POST",
            format!("/me/auth/device/{provider}/start"),
            None,
        )
    };

    let (status, body) = start("codex").await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["message"],
        json!(CODEX_DEVICE_AUTH_UNAVAILABLE_MESSAGE)
    );
    assert_eq!(usercode.hits_async().await, 1);

    let (status, body) = start("github").await?;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(
        body["message"],
        json!(GITHUB_DEVICE_AUTH_STORAGE_UNAVAILABLE_MESSAGE)
    );

    // Gemini's Google login was retired and says so.
    let (status, body) = start("gemini").await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    for provider in [
        "claude",
        "Claude",
        "claude-code",
        "claude_code",
        "claudecode",
        "claude-ai",
        "claude.ai",
        "claudeai",
        "anthropic",
        "claude-code-oauth-token",
    ] {
        let (status, body) = start(provider).await?;
        assert_eq!(status, StatusCode::NOT_FOUND, "{provider}: {body}");
        assert_eq!(
            body["message"],
            json!("unknown device auth provider"),
            "{provider}"
        );
    }
    // No other start reached Codex's issuer.
    assert_eq!(usercode.hits_async().await, 1);
    Ok(())
}

/// An issuer that authorizes at once and hands back `tokens`.
async fn authorizing_issuer(tokens: Value) -> MockServer {
    let issuer = MockServer::start_async().await;
    issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/token");
            then.status(200).json_body(json!({
                "authorization_code": "inert-authorization-code",
                "code_verifier": "inert-code-verifier",
            }));
        })
        .await;
    issuer
        .mock_async(|when, then| {
            when.method(POST).path("/oauth/token");
            then.status(200).json_body(tokens);
        })
        .await;
    issuer
}

async fn complete_codex_device_login(
    state: &crate::AppState,
    user_id: Uuid,
    issuer: &MockServer,
) -> anyhow::Result<DeviceAuthStatus> {
    let session_id = Uuid::new_v4();
    state
        .device_auth_sessions
        .insert(DeviceAuthSession {
            session_id,
            user_id,
            provider: "codex".to_string(),
            verification_url: format!("{}/codex/device", issuer.base_url()),
            user_code: "INERT-CODE".to_string(),
            poll_interval_seconds: 1,
            expires_at: Utc::now() + ChronoDuration::minutes(10),
            status: DeviceAuthStatus::Pending,
            completed_at: None,
            provider_state: DeviceAuthProviderState::Codex {
                issuer: issuer.base_url(),
                client_id: "inert-client".to_string(),
                device_auth_id: "inert-device-auth".to_string(),
            },
        })
        .await;
    tokio::time::timeout(
        Duration::from_secs(30),
        poll_codex_device_auth(state.clone(), session_id),
    )
    .await?;
    let session = state
        .device_auth_sessions
        .get(&session_id)
        .await
        .ok_or_else(|| anyhow::anyhow!("the device login session is gone"))?;
    Ok(session.status)
}

#[tokio::test]
async fn a_device_login_that_returns_claude_tokens_stores_nothing() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("device login refuses Claude tokens").await?;
    let user_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;

    let outcome = std::panic::AssertUnwindSafe(async {
        let mut config = test_config();
        config.credential_keys =
            Some(CredentialEncryptionKey::for_test("device login guard").into());
        let state = build_test_state(pool.clone(), config);
        let owned = |table: &'static str| {
            let pool = pool.clone();
            async move {
                sql_one::<i64>(
                    &pool,
                    &format!("select count(*) from {table} where user_id = $1"),
                    &[&user_id],
                )
                .await
            }
        };

        let claude = authorizing_issuer(json!({
            "id_token": "inert.id.token",
            "access_token": OAUTH_ACCESS,
            "refresh_token": OAUTH_REFRESH,
        }))
        .await;
        match complete_codex_device_login(&state, user_id, &claude).await? {
            DeviceAuthStatus::Failed { error } => {
                assert_eq!(error, CLAUDE_CREDENTIAL_REFUSED_MESSAGE)
            }
            other => anyhow::bail!("a device login with Claude tokens ended as {other:?}"),
        }
        assert_eq!(owned("user_credentials").await?, 0);
        assert_eq!(owned("user_agents").await?, 0);

        // The same login with Codex tokens is stored, so the refusal above is
        // the guard's and not the fixture's.
        let codex = authorizing_issuer(json!({
            "id_token": "inert.id.token",
            "access_token": "inert-codex-access",
            "refresh_token": "inert-codex-refresh",
        }))
        .await;
        match complete_codex_device_login(&state, user_id, &codex).await? {
            DeviceAuthStatus::Completed {
                credential_id: Some(_),
            } => {}
            other => anyhow::bail!("a device login with Codex tokens ended as {other:?}"),
        }
        assert_eq!(owned("user_credentials").await?, 1);
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = async {
        sql(
            &pool,
            "delete from user_agents where user_id = $1",
            &[&user_id],
        )
        .await?;
        sql(
            &pool,
            "delete from user_credentials where user_id = $1",
            &[&user_id],
        )
        .await?;
        sql(&pool, "delete from auth.users where id = $1", &[&user_id]).await?;
        anyhow::Ok(())
    }
    .await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
