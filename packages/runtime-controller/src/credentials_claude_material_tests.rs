//! The credential guard on stored model credentials (docs/Local-Engine-Turns.md,
//! section 6). The Codex upload refuses a Claude sign-in before it classifies
//! the body, `insert_user_credential` refuses one before it seals anything, and
//! a row stored before the guard is refused when it is opened, so it is never
//! leased, refreshed or probed. Claude API keys are not sign-ins and keep their
//! old behaviour.

use std::time::Duration;

use axum::http::StatusCode;
use axum::Json;
use bb8_postgres::PostgresConnectionManager;
use futures_util::FutureExt;
use httpmock::Method::POST;
use httpmock::MockServer;
use serde_json::{json, Value};
use uuid::Uuid;

use super::{
    decode_authoritative_credential_payload, insert_user_credential,
    CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR,
};
use crate::claude_material::{
    CLAUDE_CREDENTIAL_REFUSED_CODE, CLAUDE_CREDENTIAL_REFUSED_MESSAGE, MAX_JSON_DEPTH,
};
use crate::config::{CredentialEncryptionKey, PgPool};
use crate::credential_keys::CredentialKeyRing;
use crate::tests::{
    build_app_config, build_test_state, call_router, ensure_test_user, require_origin_test_pool,
    sql, sql_one, test_origin_private_key, test_origin_public_key,
};

// Inert stand-ins with the shapes the guard reads. None is a real key or token.
pub(crate) const OAUTH_ACCESS: &str = "sk-ant-oat01-inert-credentials-guard-access";
pub(crate) const OAUTH_REFRESH: &str = "sk-ant-ort01-inert-credentials-guard-refresh";
const API_KEY: &str = "sk-ant-api03-inert-credentials-guard-api-key";
const ADMIN_KEY: &str = "sk-ant-admin01-inert-credentials-guard-admin-key";

/// Sets an environment variable for one test and puts back what was there
/// before, however the test ends.
pub(crate) struct EnvVarGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvVarGuard {
    pub(crate) fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match self.previous.as_deref() {
            Some(previous) => std::env::set_var(self.key, previous),
            None => std::env::remove_var(self.key),
        }
    }
}

/// Claude Code's stored sign-in, as it keeps it.
fn claude_code_sign_in() -> Value {
    json!({
        "claudeAiOauth": {
            "accessToken": OAUTH_ACCESS,
            "refreshToken": OAUTH_REFRESH,
            "expiresAt": 1_900_000_000_000_u64,
            "scopes": ["user:inference", "user:profile"],
            "subscriptionType": "pro"
        }
    })
}

/// Claude tokens where a Codex login keeps its own. `classify_auth_json` would
/// store this as `codex_auth_json`, and the lease would send the refresh token
/// to OpenAI: the access token is not a JWT and there is no `last_refresh`, so
/// it is always due.
fn claude_tokens_as_codex_login() -> Value {
    json!({ "tokens": { "access_token": OAUTH_ACCESS, "refresh_token": OAUTH_REFRESH } })
}

fn assert_refused(status: StatusCode, body: &Value, case: &str) {
    assert_eq!(status, StatusCode::BAD_REQUEST, "{case}: {body}");
    assert_eq!(
        body["code"],
        json!(CLAUDE_CREDENTIAL_REFUSED_CODE),
        "{case}"
    );
    assert_eq!(
        body["message"],
        json!(CLAUDE_CREDENTIAL_REFUSED_MESSAGE),
        "{case}"
    );
}

/// A value whose innermost string sits `levels` levels down.
fn nested(levels: usize) -> Value {
    (1..levels).fold(json!("inert"), |inner, _| json!({ "next": inner }))
}

fn test_config(keys: Option<CredentialKeyRing>) -> crate::AppConfig {
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "credentials-claude-material",
    );
    config.credential_keys = keys;
    config
}

#[tokio::test]
async fn the_credential_sink_refuses_a_claude_sign_in_before_sealing_or_the_database(
) -> anyhow::Result<()> {
    // No encryption key and no reachable database: a refusal that came after
    // either would be a 500 instead. Device login stores through this sink.
    let manager = PostgresConnectionManager::new_from_stringlike(
        "postgresql://postgres:postgres@127.0.0.1:1/postgres",
        crate::config::database_tls(),
    )?;
    let pool = bb8::Pool::builder()
        .max_size(1)
        .connection_timeout(Duration::from_millis(500))
        .build_unchecked(manager);
    let state = build_test_state(pool, test_config(None));
    for (case, auth_json) in [
        ("stored sign-in", claude_code_sign_in()),
        ("tokens", claude_tokens_as_codex_login()),
        ("api key field", json!({ "OPENAI_API_KEY": OAUTH_ACCESS })),
    ] {
        let result = insert_user_credential(
            &state,
            Uuid::new_v4(),
            "codex_auth_json".to_string(),
            json!({ "source": "device_code" }),
            auth_json,
            Some("ChatGPT".to_string()),
            None,
        )
        .await;
        let Err((status, Json(error))) = result else {
            anyhow::bail!("{case}: a Claude sign-in was stored");
        };
        assert_eq!(status, StatusCode::BAD_REQUEST, "{case}: {}", error.message);
        assert_eq!(
            error.code.as_deref(),
            Some(CLAUDE_CREDENTIAL_REFUSED_CODE),
            "{case}"
        );
        assert_eq!(error.message, CLAUDE_CREDENTIAL_REFUSED_MESSAGE, "{case}");
    }
    Ok(())
}

#[test]
fn opening_a_stored_claude_sign_in_is_refused() {
    let keys: CredentialKeyRing = CredentialEncryptionKey::for_test("decode guard").into();
    let seal = |payload: &Value| {
        keys.seal(&serde_json::to_vec(payload).expect("payload encodes"))
            .expect("payload seals")
    };
    for payload in [claude_code_sign_in(), claude_tokens_as_codex_login()] {
        let (nonce, ciphertext) = seal(&payload);
        let (status, Json(error)) =
            decode_authoritative_credential_payload(&keys, &nonce, &ciphertext)
                .expect_err("a stored Claude sign-in must not decode");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code.as_deref(), Some(CLAUDE_CREDENTIAL_REFUSED_CODE));
        assert!(!error.message.contains("sk-ant-"), "{}", error.message);
    }
    // What is not a Claude sign-in decodes as it did.
    for payload in [
        json!({ "tokens": { "access_token": "inert-codex-access", "refresh_token": "inert" } }),
        json!({ "OPENAI_API_KEY": API_KEY }),
        json!({ "OPENAI_API_KEY": ADMIN_KEY }),
    ] {
        let (nonce, ciphertext) = seal(&payload);
        assert_eq!(
            decode_authoritative_credential_payload(&keys, &nonce, &ciphertext).expect("decodes"),
            payload
        );
    }
}

/// Deletes `user_id` and, with it, every credential and agent it owns.
async fn delete_user(pool: &PgPool, user_id: Uuid) -> anyhow::Result<()> {
    sql(
        pool,
        "delete from user_agents where user_id = $1",
        &[&user_id],
    )
    .await?;
    sql(
        pool,
        "delete from user_credentials where user_id = $1",
        &[&user_id],
    )
    .await?;
    sql(pool, "delete from auth.users where id = $1", &[&user_id]).await?;
    Ok(())
}

async fn count_owned(pool: &PgPool, table: &str, user_id: Uuid) -> anyhow::Result<i64> {
    sql_one(
        pool,
        &format!("select count(*) from {table} where user_id = $1"),
        &[&user_id],
    )
    .await
}

#[tokio::test]
async fn the_codex_upload_refuses_a_claude_sign_in_and_stores_nothing() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("Codex upload refuses a Claude sign-in").await?;
    let user_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;

    let outcome = std::panic::AssertUnwindSafe(async {
        let config = test_config(Some(
            CredentialEncryptionKey::for_test("codex upload guard").into(),
        ));
        let bearer = crate::auth::issue_controller_token(&config, &user_id)
            .map(|issued| format!("Bearer {}", issued.token))
            .map_err(|(status, error)| anyhow::anyhow!("{status}: {}", error.0.message))?;
        let app = super::router().with_state(build_test_state(pool.clone(), config));
        let upload = |auth_json: Value| {
            call_router(
                &app,
                Some(&bearer),
                "POST",
                "/me/credentials/codex".to_string(),
                Some(json!({ "authJson": auth_json, "label": "Guard test" })),
            )
        };

        for (case, auth_json) in [
            ("Claude Code's stored sign-in", claude_code_sign_in()),
            (
                "a Claude body stored as codex_auth_json",
                claude_tokens_as_codex_login(),
            ),
            (
                "a Claude refresh token beside a Codex access token",
                json!({ "tokens": { "access_token": "inert-codex-access", "refresh_token": OAUTH_REFRESH } }),
            ),
            (
                "an upper-case Claude token as an API key",
                json!({ "OPENAI_API_KEY": OAUTH_ACCESS.to_ascii_uppercase() }),
            ),
            ("a bare Claude token", json!(OAUTH_ACCESS)),
            (
                "a body deeper than the guard reads",
                json!({
                    "tokens": { "access_token": "inert-codex-access" },
                    "extra": nested(MAX_JSON_DEPTH),
                }),
            ),
        ] {
            let (status, body) = upload(auth_json).await?;
            assert_refused(status, &body, case);
        }
        assert_eq!(count_owned(&pool, "user_credentials", user_id).await?, 0);
        assert_eq!(count_owned(&pool, "user_agents", user_id).await?, 0);

        // The narrow rule: what is not a Claude sign-in is stored as before.
        for auth_json in [
            json!({ "tokens": { "access_token": "inert-codex-access", "account_id": "acct_inert" } }),
            json!({ "OPENAI_API_KEY": API_KEY }),
        ] {
            let (status, body) = upload(auth_json).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
        }
        assert_eq!(count_owned(&pool, "user_credentials", user_id).await?, 2);
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = delete_user(&pool, user_id).await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn store_credential(
    pool: &PgPool,
    keys: &CredentialKeyRing,
    user_id: Uuid,
    kind: &str,
    payload: &Value,
) -> anyhow::Result<Uuid> {
    let credential_id = Uuid::new_v4();
    let (nonce, ciphertext) = keys.seal(&serde_json::to_vec(payload)?)?;
    sql(
        pool,
        "insert into user_credentials (id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata)
         values ($1, $2, $3, 'Stored before the guard', $4, $5, '{\"provider\": \"openai\"}'::jsonb)",
        &[&credential_id, &user_id, &kind, &nonce, &ciphertext],
    )
    .await?;
    Ok(credential_id)
}

async fn stored_row(
    pool: &PgPool,
    credential_id: Uuid,
) -> anyhow::Result<(String, String, Option<chrono::DateTime<chrono::Utc>>)> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select nonce_b64, ciphertext_b64, last_used_at from user_credentials where id = $1",
            &[&credential_id],
        )
        .await?;
    Ok((row.get(0), row.get(1), row.get(2)))
}

#[tokio::test]
async fn a_stored_claude_sign_in_is_never_leased_refreshed_or_probed() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a stored Claude sign-in is never leased").await?;
    // Every Codex refresh goes to this recorder, never to OpenAI.
    let token_endpoint = MockServer::start_async().await;
    let refresh = token_endpoint
        .mock_async(|when, then| {
            when.method(POST).path("/oauth/token");
            then.status(200).json_body(json!({
                "access_token": "inert-refreshed-access",
                "refresh_token": "inert-refreshed-refresh",
                "id_token": "inert.id.token"
            }));
        })
        .await;
    let _refresh_url = EnvVarGuard::set(
        CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR,
        &token_endpoint.url("/oauth/token"),
    );
    let user_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;
    let keys: CredentialKeyRing =
        CredentialEncryptionKey::for_test(&format!("legacy lease guard {user_id}")).into();

    let outcome = std::panic::AssertUnwindSafe(async {
        let stored_sign_in = store_credential(
            &pool,
            &keys,
            user_id,
            "codex_auth_json",
            &claude_code_sign_in(),
        )
        .await?;
        let stored_tokens = store_credential(
            &pool,
            &keys,
            user_id,
            "codex_auth_json",
            &claude_tokens_as_codex_login(),
        )
        .await?;
        let codex_login = store_credential(
            &pool,
            &keys,
            user_id,
            "codex_auth_json",
            &json!({ "tokens": {
                "access_token": "inert-codex-access",
                "refresh_token": "inert-codex-refresh"
            } }),
        )
        .await?;
        let api_key = store_credential(
            &pool,
            &keys,
            user_id,
            "openai_api_key",
            &json!({ "OPENAI_API_KEY": API_KEY }),
        )
        .await?;
        let app =
            super::router().with_state(build_test_state(pool.clone(), test_config(Some(keys))));
        let lease = |credential_id: Uuid, query: &str| {
            call_router(
                &app,
                Some("Bearer credential-lease"),
                "GET",
                format!("/internal/credentials/{credential_id}{query}"),
                None,
            )
        };

        for credential_id in [stored_sign_in, stored_tokens] {
            let before = stored_row(&pool, credential_id).await?;
            // A lease, and the forced refresh the proxy asks for after an
            // upstream rejection; a probe reaches the row through a lease.
            for query in ["", "?forceRefresh=true"] {
                let (status, body) = lease(credential_id, query).await?;
                assert_refused(status, &body, &format!("lease{query}"));
                assert!(!body.to_string().contains("sk-ant-"), "{body}");
            }
            // Nothing was refreshed, rewritten or marked used.
            assert_eq!(stored_row(&pool, credential_id).await?, before);
            assert!(before.2.is_none());
        }
        assert_eq!(
            refresh.hits_async().await,
            0,
            "a stored Claude token reached the refresh endpoint"
        );

        // The recorder is live: a Codex login that is due refreshes through it.
        let (status, body) = lease(codex_login, "").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["accessToken"], json!("inert-refreshed-access"));
        assert_eq!(refresh.hits_async().await, 1);

        // A Claude API key is not a sign-in, and leases as before.
        let (status, body) = lease(api_key, "").await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["openaiApiKey"], json!(API_KEY));
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = delete_user(&pool, user_id).await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
