//! The credential guard on project secrets (docs/Local-Engine-Turns.md,
//! section 6): create refuses the reserved name and Claude values, update
//! refuses a Claude value and a new value for a reserved name, delivery skips
//! such a secret by handle and by id, and the listing marks it `refused`
//! without returning any value. The guard is narrow: Claude API and Admin API
//! keys are stored and delivered under any other name, as before.
//!
//! The database tests run on the shared test database. Each makes its own user
//! and space and deletes them, and their secrets, however it ends.

use axum::http::StatusCode;
use axum::Router;
use chrono::{DateTime, Duration, Utc};
use futures_util::FutureExt;
use serde_json::{json, Value};
use uuid::Uuid;

use super::security_tests::{request_secrets, test_config};
use crate::claude_material::{
    is_reserved_secret_name, CLAUDE_CREDENTIAL_REFUSED_CODE, CLAUDE_CREDENTIAL_REFUSED_MESSAGE,
    RESERVED_SECRET_NAME,
};
use crate::config::{CredentialEncryptionKey, PgPool};
use crate::credential_keys::CredentialKeyRing;
use crate::tests::{
    build_test_state, call_router, ensure_test_user, require_origin_test_pool, sql, sql_one,
};

// Inert stand-ins with the shapes the guard reads. None is a real key or token.
const OAUTH_ACCESS: &str = "sk-ant-oat01-inert-secrets-guard-access";
const OAUTH_REFRESH: &str = "sk-ant-ort01-inert-secrets-guard-refresh";
const API_KEY: &str = "sk-ant-api03-inert-secrets-guard-api-key";
const ADMIN_KEY: &str = "sk-ant-admin01-inert-secrets-guard-admin-key";

fn claude_code_sign_in() -> String {
    json!({
        "claudeAiOauth": {
            "accessToken": OAUTH_ACCESS,
            "refreshToken": OAUTH_REFRESH,
            "expiresAt": 1_900_000_000_000_u64,
            "scopes": ["user:inference"]
        }
    })
    .to_string()
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

#[test]
fn the_reserved_name_is_what_normalize_secret_name_makes_of_it() {
    for name in [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "claude-code-oauth-token",
        "Claude Code OAuth Token",
        " claude_code-oauth token ",
    ] {
        assert_eq!(
            super::normalize_secret_name(name).ok().as_deref(),
            Some(RESERVED_SECRET_NAME),
            "{name:?}"
        );
        assert!(is_reserved_secret_name(name), "{name:?}");
    }
    for name in [
        "CLAUDE_CODE_OAUTH_TOKEN_2",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH",
        "CLAUDE__CODE_OAUTH_TOKEN",
    ] {
        let normalized = super::normalize_secret_name(name).expect("a valid name");
        assert_ne!(normalized, RESERVED_SECRET_NAME, "{name:?}");
        assert!(!is_reserved_secret_name(name), "{name:?}");
    }
}

struct Space {
    pool: PgPool,
    app: Router,
    keys: CredentialKeyRing,
    owner: Uuid,
    project_id: Uuid,
    bearer: String,
}

impl Space {
    fn secrets_path(&self) -> String {
        format!("/projects/{}/secrets", self.project_id)
    }

    async fn create(&self, name: &str, value: &str) -> anyhow::Result<(StatusCode, Value)> {
        call_router(
            &self.app,
            Some(&self.bearer),
            "POST",
            self.secrets_path(),
            Some(json!({ "name": name, "value": value })),
        )
        .await
    }

    async fn update(&self, secret_id: Uuid, body: Value) -> anyhow::Result<(StatusCode, Value)> {
        call_router(
            &self.app,
            Some(&self.bearer),
            "PATCH",
            format!("{}/{secret_id}", self.secrets_path()),
            Some(body),
        )
        .await
    }

    /// Stores a secret as a release before the guard could have: sealed with
    /// the space's key, under a name the API may no longer accept.
    async fn store_legacy(&self, name: &str, value: &str) -> anyhow::Result<Uuid> {
        let (nonce, ciphertext) = self.keys.seal(value.as_bytes())?;
        self.store_sealed(name, &nonce, &ciphertext).await
    }

    async fn store_sealed(
        &self,
        name: &str,
        nonce: &str,
        ciphertext: &str,
    ) -> anyhow::Result<Uuid> {
        let secret_id = Uuid::new_v4();
        sql(
            &self.pool,
            "insert into project_secrets (id, project_id, user_id, name, nonce_b64, ciphertext_b64)
             values ($1, $2, $3, $4, $5, $6)",
            &[
                &secret_id,
                &self.project_id,
                &self.owner,
                &name,
                &nonce,
                &ciphertext,
            ],
        )
        .await?;
        Ok(secret_id)
    }

    async fn sealed_value(&self, secret_id: Uuid) -> anyhow::Result<(String, String)> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select nonce_b64, ciphertext_b64 from project_secrets where id = $1",
                &[&secret_id],
            )
            .await?;
        Ok((row.get(0), row.get(1)))
    }

    async fn stored_count(&self) -> anyhow::Result<i64> {
        sql_one(
            &self.pool,
            "select count(*) from project_secrets where project_id = $1 and revoked_at is null",
            &[&self.project_id],
        )
        .await
    }
}

/// Runs `body` with a fresh owner and space on the shared test database, then
/// deletes them and the space's secrets, however `body` ends.
async fn with_space<F, Fut>(label: &str, body: F) -> anyhow::Result<()>
where
    F: FnOnce(Space) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let pool = require_origin_test_pool(label).await?;
    super::ensure_secret_tables(&pool).await?;
    let owner = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner).await?;

    let outcome = std::panic::AssertUnwindSafe(async {
        sql(
            &pool,
            "insert into projects (id, owner_user_id, project_type, status)
             values ($1, $2, 'customer', 'active')",
            &[&project_id, &owner],
        )
        .await?;
        let keys: CredentialKeyRing =
            CredentialEncryptionKey::for_test(&format!("{label}-{project_id}")).into();
        let mut config = test_config();
        config.credential_keys = Some(keys.clone());
        let bearer = crate::auth::issue_controller_token(&config, &owner)
            .map(|issued| format!("Bearer {}", issued.token))
            .map_err(|(status, error)| anyhow::anyhow!("{status}: {}", error.0.message))?;
        let app = super::router().with_state(build_test_state(pool.clone(), config));
        body(Space {
            pool: pool.clone(),
            app,
            keys,
            owner,
            project_id,
            bearer,
        })
        .await
    })
    .catch_unwind()
    .await;

    // Grants go with their secrets; runtimes and jobs with their space.
    let cleanup = async {
        sql(
            &pool,
            "delete from project_secrets where project_id = $1",
            &[&project_id],
        )
        .await?;
        sql(&pool, "delete from projects where id = $1", &[&project_id]).await?;
        sql(
            &pool,
            "delete from user_agents where user_id = $1",
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

#[tokio::test]
async fn creating_a_secret_refuses_a_claude_sign_in_and_keeps_api_keys() -> anyhow::Result<()> {
    with_space("secret create guard", |space| async move {
        let sign_in = claude_code_sign_in();
        for (name, value) in [
            ("CLAUDE_CODE_OAUTH_TOKEN", "inert-reserved-value"),
            ("claude-code-oauth-token", "inert-reserved-value"),
            ("Claude Code OAuth Token", "inert-reserved-value"),
            ("DEPLOY_TOKEN", OAUTH_ACCESS),
            ("DEPLOY_TOKEN", "SK-ANT-ORT01-INERT-UPPER-CASE"),
            ("DEPLOY_TOKEN", "  token: sk-ant-oat01-inert  "),
            ("SETTINGS_JSON", sign_in.as_str()),
            ("NOTES", "copied from claude_ai_oauth"),
        ] {
            let (status, body) = space.create(name, value).await?;
            assert_refused(status, &body, &format!("create {name}"));
        }
        assert_eq!(space.stored_count().await?, 0, "a refused secret is stored");

        // The narrow rule: API keys under any other name, and a letter or
        // digit right before the prefix, are stored as before.
        for (name, value) in [
            ("ANTHROPIC_API_KEY", API_KEY),
            ("ANTHROPIC_ADMIN_KEY", ADMIN_KEY),
            ("RISK_NOTE", "risk-ant-oat01-inert"),
        ] {
            let (status, body) = space.create(name, value).await?;
            assert_eq!(status, StatusCode::OK, "create {name}: {body}");
        }
        assert_eq!(space.stored_count().await?, 3);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn updating_a_secret_refuses_a_claude_value_and_a_reserved_names_new_value(
) -> anyhow::Result<()> {
    with_space("secret update guard", |space| async move {
        let (status, created) = space.create("DEPLOY_TOKEN", "inert-deploy-token").await?;
        assert_eq!(status, StatusCode::OK, "{created}");
        let deploy: Uuid = created["id"].as_str().unwrap_or_default().parse()?;
        let sealed = space.sealed_value(deploy).await?;
        for value in [
            OAUTH_ACCESS.to_string(),
            OAUTH_REFRESH.to_ascii_uppercase(),
            claude_code_sign_in(),
        ] {
            let (status, body) = space.update(deploy, json!({ "value": value })).await?;
            assert_refused(status, &body, "a Claude value");
        }
        assert_eq!(space.sealed_value(deploy).await?, sealed);

        // An update carries no name: the stored one decides.
        let reserved = space
            .store_legacy("CLAUDE_CODE_OAUTH_TOKEN", "inert-legacy-value")
            .await?;
        let sealed = space.sealed_value(reserved).await?;
        let (status, body) = space
            .update(reserved, json!({ "value": "inert-new-value" }))
            .await?;
        assert_refused(status, &body, "a new value for the reserved name");
        assert_eq!(space.sealed_value(reserved).await?, sealed);
        // Its description and grants can still change, and it stays marked.
        let (status, body) = space
            .update(
                reserved,
                json!({ "description": "remove me", "agentHandles": ["octo"] }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["refused"], json!(true), "{body}");
        assert_eq!(space.sealed_value(reserved).await?, sealed);
        assert!(!body.to_string().contains("inert-legacy-value"));

        // API keys stay allowed as a new value.
        for value in [API_KEY, ADMIN_KEY] {
            let (status, body) = space.update(deploy, json!({ "value": value })).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(body.get("refused").is_none(), "{body}");
            assert!(!body.to_string().contains(value));
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn delivery_skips_claude_sign_ins_by_handle_and_by_id() -> anyhow::Result<()> {
    with_space("secret delivery guard", |space| async move {
        let agent_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        sql(
            &space.pool,
            "insert into user_agents (id, user_id, provider, handle, avatar_seed)
             values ($1, $2, 'openai', 'guard-agent', 'guard-agent')",
            &[&agent_id, &space.owner],
        )
        .await?;
        sql(
            &space.pool,
            "insert into runtimes (id, project_id, provider, status, capabilities)
             values ($1, $2, 'instafy-cloud', 'ready', $3)",
            &[&runtime_id, &space.project_id, &json!({ "agent": true })],
        )
        .await?;
        sql(
            &space.pool,
            "insert into agent_jobs (
                 id, project_id, status, intent, leased_by_runtime_id, lease_expires_at, payload
             ) values ($1, $2, 'leased', 'feature', $3, $4, $5)",
            &[
                &job_id,
                &space.project_id,
                &runtime_id,
                &(Utc::now() + Duration::minutes(10)),
                &json!({ "metadata": {
                    "userId": space.owner,
                    "agent": { "id": agent_id, "handle": "guard-agent" }
                } }),
            ],
        )
        .await?;

        let sign_in = claude_code_sign_in();
        let by_handle = [
            ("CLAUDE_CODE_OAUTH_TOKEN", "inert-reserved-value", false),
            (
                "claude-code-oauth-token",
                "inert-lower-case-reserved",
                false,
            ),
            ("HANDLE_CLAUDE_TOKEN", OAUTH_ACCESS, false),
            ("ANTHROPIC_API_KEY", API_KEY, true),
            ("HANDLE_PLAIN", "inert-handle-plain", true),
        ];
        let by_id = [
            ("ID_CLAUDE_SIGN_IN", sign_in.as_str(), false),
            ("ID_CLAUDE_REFRESH", OAUTH_REFRESH, false),
            ("ID_ADMIN_KEY", ADMIN_KEY, true),
        ];
        let mut skipped = Vec::new();
        let mut delivered = Vec::new();
        for (name, value, deliverable) in by_handle {
            let secret_id = space.store_legacy(name, value).await?;
            sql(
                &space.pool,
                "insert into project_secret_agent_handle_grants (secret_id, agent_handle)
                 values ($1, 'guard-agent')",
                &[&secret_id],
            )
            .await?;
            if deliverable {
                delivered.push((secret_id, name, value));
            } else {
                skipped.push((secret_id, name, value));
            }
        }
        for (name, value, deliverable) in by_id {
            let secret_id = space.store_legacy(name, value).await?;
            sql(
                &space.pool,
                "insert into project_secret_agent_grants (secret_id, agent_id) values ($1, $2)",
                &[&secret_id, &agent_id],
            )
            .await?;
            if deliverable {
                delivered.push((secret_id, name, value));
            } else {
                skipped.push((secret_id, name, value));
            }
        }
        // A reserved name is skipped before anything is decrypted, so a row no
        // key opens does not fail the job's other secrets.
        let unreadable = space
            .store_sealed("Claude Code OAuth Token", "AAAAAAAAAAAAAAAA", "AAAA")
            .await?;
        sql(
            &space.pool,
            "insert into project_secret_agent_handle_grants (secret_id, agent_handle)
             values ($1, 'guard-agent')",
            &[&unreadable],
        )
        .await?;

        let mut config = test_config();
        config.credential_keys = Some(space.keys.clone());
        let token =
            crate::auth::issue_agent_token(&config, &space.project_id, &runtime_id, None, None)
                .map(|minted| minted.token)
                .map_err(|(status, error)| anyhow::anyhow!("{status}: {}", error.0.message))?;
        let app = super::router().with_state(build_test_state(space.pool.clone(), config));
        let (status, body) = request_secrets(&app, &token, json!({ "job_id": job_id })).await?;
        // The body carries secret values, so it is never printed.
        assert!(status == StatusCode::OK, "agent secrets answered {status}");

        let env = &body["env"];
        for (_, name, value) in &delivered {
            assert!(env[*name] == json!(value), "{name} was not delivered");
        }
        for (_, name, value) in &skipped {
            assert!(env.get(*name).is_none(), "{name} was delivered");
            assert!(
                !body.to_string().contains(value),
                "{name}'s value reached the job"
            );
        }
        assert!(env.get("Claude Code OAuth Token").is_none());
        let mut inventory: Vec<&str> = body["inventory"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["name"].as_str())
                    .collect()
            })
            .unwrap_or_default();
        inventory.sort_unstable();
        let mut expected: Vec<&str> = delivered.iter().map(|(_, name, _)| *name).collect();
        expected.sort_unstable();
        assert_eq!(inventory, expected);

        // Only what was delivered counts as used.
        for (secret_id, name, _) in delivered.iter().chain(skipped.iter()) {
            let used: Option<DateTime<Utc>> = sql_one(
                &space.pool,
                "select last_used_at from project_secrets where id = $1",
                &[secret_id],
            )
            .await?;
            let deliverable = delivered.iter().any(|(id, _, _)| id == secret_id);
            assert_eq!(used.is_some(), deliverable, "{name}");
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn listing_marks_refused_secrets_and_returns_no_value() -> anyhow::Result<()> {
    with_space("secret listing guard", |space| async move {
        let sign_in = claude_code_sign_in();
        let stored = [
            (
                "CLAUDE_CODE_OAUTH_TOKEN",
                "inert-reserved-listing-value",
                true,
            ),
            ("LEGACY_REFRESH", OAUTH_REFRESH, true),
            ("LEGACY_SIGN_IN", sign_in.as_str(), true),
            ("ANTHROPIC_API_KEY", API_KEY, false),
            ("PLAIN", "inert-plain-listing-value", false),
        ];
        for (name, value, _) in stored {
            space.store_legacy(name, value).await?;
        }
        // A row no configured key opens is judged by its name alone.
        space
            .store_sealed("UNREADABLE", "AAAAAAAAAAAAAAAA", "AAAA")
            .await?;

        let (status, body) = call_router(
            &space.app,
            Some(&space.bearer),
            "GET",
            space.secrets_path(),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let items = body.as_array().cloned().unwrap_or_default();
        assert_eq!(items.len(), stored.len() + 1, "{body}");
        for item in &items {
            let name = item["name"].as_str().unwrap_or_default();
            let refused = stored
                .iter()
                .find(|(stored_name, _, _)| *stored_name == name)
                .is_some_and(|(_, _, refused)| *refused);
            if refused {
                assert_eq!(item["refused"], json!(true), "{name}: {item}");
            } else {
                // Unchanged for every other secret: no key at all.
                assert!(item.get("refused").is_none(), "{name}: {item}");
            }
            assert!(item.get("value").is_none(), "{name}: {item}");
        }
        let text = body.to_string();
        for (name, value, _) in stored {
            assert!(!text.contains(value), "the listing returned {name}'s value");
        }
        assert!(!text.contains("sk-ant-"), "{body}");
        Ok(())
    })
    .await
}
