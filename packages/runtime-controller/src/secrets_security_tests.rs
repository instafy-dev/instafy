use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use bb8_postgres::PostgresConnectionManager;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{AppConfig, CredentialEncryptionKey};
use crate::tests::{
    build_app_config, build_test_state, require_origin_test_pool, test_origin_private_key,
    test_origin_public_key,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};

fn test_config() -> AppConfig {
    build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "test-agent-secrets-key",
    )
}

fn unbound_secret_token(config: &AppConfig, project_id: Uuid) -> anyhow::Result<String> {
    mint_scoped_token(
        config,
        ScopedTokenRequest {
            audience: "runtime-agent".to_string(),
            subject: "test-agent".to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: None,
            scopes: vec!["agent.secrets".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map(|minted| minted.token)
    .map_err(|(status, error)| anyhow::anyhow!("token mint failed: {status}: {}", error.0.message))
}

async fn request_secrets(
    app: &Router,
    token: &str,
    body: Value,
) -> anyhow::Result<(StatusCode, Value)> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/secrets")
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    let status = response.status();
    let body = serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
    Ok((status, body))
}

#[tokio::test]
async fn agent_secrets_requires_runtime_scope_before_database_or_key_access() -> anyhow::Result<()>
{
    for strict_mode in [false, true] {
        let mut config = test_config();
        config.strict_mode = strict_mode;
        // Deliberately no encryption key or reachable database: authentication must fail first.
        let manager = PostgresConnectionManager::new_from_stringlike(
            "postgresql://postgres:postgres@127.0.0.1:1/postgres",
            crate::config::database_tls(),
        )?;
        let pool = bb8::Pool::builder().max_size(1).build_unchecked(manager);
        let token = unbound_secret_token(&config, Uuid::new_v4())?;
        let app = super::router().with_state(build_test_state(pool, config));
        let (status, body) = request_secrets(
            &app,
            &token,
            json!({ "job_id": Uuid::new_v4(), "runtime_id": Uuid::new_v4() }),
        )
        .await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert!(body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("missing runtime scope"));
    }
    Ok(())
}

#[tokio::test]
async fn agent_secrets_only_releases_to_current_runtime_owning_live_job() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("agent secrets ownership regression").await?;
    let project_id = Uuid::new_v4();
    let other_project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let other_runtime_id = Uuid::new_v4();
    let foreign_runtime_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let generation = Uuid::new_v4();
    let secret_id = Uuid::new_v4();
    let key = CredentialEncryptionKey::for_test("agent secrets ownership regression");

    let result: anyhow::Result<()> = async {
        super::ensure_secret_tables(&pool).await?;
        let (nonce, ciphertext) = super::encrypt_secret_payload(&key, b"private-secret-marker")?;
        {
            let connection = pool.get().await?;
            for id in [project_id, other_project_id] {
                connection.execute(
                    "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
                    &[&id],
                ).await?;
            }
            for (id, project) in [
                (runtime_id, project_id),
                (other_runtime_id, project_id),
                (foreign_runtime_id, other_project_id),
            ] {
                connection.execute(
                    "insert into runtimes (id, project_id, provider, status, capabilities)
                     values ($1, $2, 'self-hosted', 'ready', $3)",
                    &[&id, &project, &json!({
                        "agent": true,
                        "_instafySelfHostedAccess": { "mode": "private", "ownerUserId": Uuid::new_v4() },
                        "_instafyRuntimeTokenGeneration": generation,
                    })],
                ).await?;
            }
            connection.execute(
                "insert into agent_jobs (id, project_id, status, leased_by_runtime_id, lease_expires_at, payload)
                 values ($1, $2, 'leased', $3, $4, $5)",
                &[&job_id, &project_id, &runtime_id, &(Utc::now() + Duration::minutes(10)),
                  &json!({ "metadata": { "agent": { "handle": "secrets-test-agent" } } })],
            ).await?;
            connection.execute(
                "insert into project_secrets (id, project_id, user_id, name, nonce_b64, ciphertext_b64)
                 values ($1, $2, $3, 'SECURITY_TEST_SECRET', $4, $5)",
                &[&secret_id, &project_id, &Uuid::new_v4(), &nonce, &ciphertext],
            ).await?;
            connection.execute(
                "insert into project_secret_agent_handle_grants (secret_id, agent_handle)
                 values ($1, 'secrets-test-agent')", &[&secret_id],
            ).await?;
        }

        for strict_mode in [false, true] {
            let mut config = test_config();
            config.strict_mode = strict_mode;
            config.credential_encryption_key = Some(key.clone());
            let issue = |id: Uuid, token_generation: Option<Uuid>| {
                crate::auth::issue_agent_token(&config, &project_id, &id, None, token_generation)
                    .map(|minted| minted.token)
                    .map_err(|(status, error)| anyhow::anyhow!("token mint failed: {status}: {}", error.0.message))
            };
            let token = issue(runtime_id, Some(generation))?;
            let rejected_tokens = [
                ("unbound", unbound_secret_token(&config, project_id)?),
                ("different runtime", issue(other_runtime_id, Some(generation))?),
                ("different project", issue(foreign_runtime_id, Some(generation))?),
                ("unregistered runtime", issue(Uuid::new_v4(), Some(generation))?),
                ("missing generation", issue(runtime_id, None)?),
                ("stale generation", issue(runtime_id, Some(Uuid::new_v4()))?),
            ];
            let app = super::router().with_state(build_test_state(pool.clone(), config));
            for (case, rejected_token) in rejected_tokens {
                let (status, body) = request_secrets(&app, &rejected_token, json!({ "job_id": job_id })).await?;
                anyhow::ensure!(status == StatusCode::UNAUTHORIZED, "{case}, strict={strict_mode}: {status}: {body}");
                anyhow::ensure!(!body.to_string().contains("private-secret-marker"), "{case} exposed secret");
                let row = pool.get().await?.query_one(
                    "select last_used_at from project_secrets where id = $1", &[&secret_id],
                ).await?;
                anyhow::ensure!(row.get::<_, Option<chrono::DateTime<Utc>>>("last_used_at").is_none());
            }

            let (status, body) = request_secrets(&app, &token, json!({ "job_id": job_id, "touch": false })).await?;
            anyhow::ensure!(status == StatusCode::OK, "strict={strict_mode}: {status}: {body}");
            anyhow::ensure!(body["env"]["SECURITY_TEST_SECRET"] == "private-secret-marker");

            for (case, owner, expiry, job_status, runtime_status, expected) in [
                ("unowned", None, Some(Utc::now() + Duration::minutes(10)), "leased", "ready", StatusCode::UNAUTHORIZED),
                ("expired", Some(runtime_id), Some(Utc::now() - Duration::seconds(1)), "leased", "ready", StatusCode::UNAUTHORIZED),
                ("missing expiry", Some(runtime_id), None, "leased", "ready", StatusCode::UNAUTHORIZED),
                ("completed", Some(runtime_id), Some(Utc::now() + Duration::minutes(10)), "completed", "ready", StatusCode::BAD_REQUEST),
                ("stopped runtime", Some(runtime_id), Some(Utc::now() + Duration::minutes(10)), "leased", "stopped", StatusCode::UNAUTHORIZED),
            ] {
                {
                    let connection = pool.get().await?;
                    connection.execute(
                        "update agent_jobs set leased_by_runtime_id = $2, lease_expires_at = $3, status = $4 where id = $1",
                        &[&job_id, &owner, &expiry, &job_status],
                    ).await?;
                    connection.execute("update runtimes set status = $2 where id = $1", &[&runtime_id, &runtime_status]).await?;
                }
                let (status, body) = request_secrets(&app, &token, json!({ "job_id": job_id })).await?;
                anyhow::ensure!(status == expected, "{case}, strict={strict_mode}: {status}: {body}");
                anyhow::ensure!(!body.to_string().contains("private-secret-marker"), "{case} exposed secret");
            }
            let connection = pool.get().await?;
            connection.execute(
                "update agent_jobs set status = 'leased', leased_by_runtime_id = $2, lease_expires_at = $3 where id = $1",
                &[&job_id, &runtime_id, &(Utc::now() + Duration::minutes(10))],
            ).await?;
            connection.execute("update runtimes set status = 'ready' where id = $1", &[&runtime_id]).await?;
        }
        Ok(())
    }.await;

    let connection = pool.get().await?;
    let secret_cleanup = connection
        .execute("delete from project_secrets where id = $1", &[&secret_id])
        .await;
    let project_cleanup = connection
        .execute(
            "delete from projects where id = any($1::uuid[])",
            &[&vec![project_id, other_project_id]],
        )
        .await;
    result?;
    secret_cleanup?;
    project_cleanup?;
    Ok(())
}
