//! Codex's local model follows the job's lane. A platform-lane job (an AI job
//! whose target has no credential) runs on the managed model the proxy pins,
//! whatever its payload says and whether or not it names an agent.

use axum::http::StatusCode;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use super::security_tests::{request_secrets, test_config};
use crate::config::CredentialEncryptionKey;
use crate::model_defaults::default_managed_ai_model_id;
use crate::tests::{build_test_state, ensure_test_user, require_origin_test_pool};

/// The model configured on the job's agent (`user_agents.model`).
const AGENT_MODEL: &str = "glm-4.5";

struct LaneJob {
    has_credential: bool,
    intent: &'static str,
    names_agent: bool,
}

/// Seed a job leased by a hosted runtime and return the env `/agent/secrets`
/// hands the runtime for it. The job's user has an agent configured with
/// `AGENT_MODEL`, and the payload says `managedAiUsed: false`, as it does for
/// a service-role job or an ambient evaluation that has not answered yet.
async fn agent_secrets_env(label: &str, job: LaneJob) -> anyhow::Result<Value> {
    let pool = require_origin_test_pool(label).await?;
    let user_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let agent_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;

    let result: anyhow::Result<Value> = async {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, owner_user_id, project_type, status)
                 values ($1, $2, 'customer', 'active')",
                &[&project_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status, capabilities)
                 values ($1, $2, 'instafy-cloud', 'ready', $3)",
                &[&runtime_id, &project_id, &json!({ "agent": true })],
            )
            .await?;
        connection
            .execute(
                "insert into user_agents (id, user_id, provider, handle, avatar_seed, model)
                 values ($1, $2, 'zai', 'lane-agent', 'lane-agent', $3)",
                &[&agent_id, &user_id, &AGENT_MODEL],
            )
            .await?;
        if job.has_credential {
            connection
                .execute(
                    "insert into user_credentials (
                         id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata
                     ) values ($1, $2, 'openai_api_key', 'Lane test', 'test-nonce',
                         'test-ciphertext', '{}'::jsonb)",
                    &[&credential_id, &user_id],
                )
                .await?;
        }
        let mut metadata = json!({ "userId": user_id, "managedAiUsed": false });
        if job.names_agent {
            metadata["agent"] = json!({ "id": agent_id, "handle": "lane-agent" });
        }
        connection
            .execute(
                "insert into agent_jobs (
                     id, project_id, status, intent, credential_id,
                     leased_by_runtime_id, lease_expires_at, payload
                 ) values ($1, $2, 'leased', $3, $4, $5, $6, $7)",
                &[
                    &job_id,
                    &project_id,
                    &job.intent,
                    &job.has_credential.then_some(credential_id),
                    &runtime_id,
                    &(Utc::now() + Duration::minutes(10)),
                    &json!({ "metadata": metadata }),
                ],
            )
            .await?;
        drop(connection);

        let mut config = test_config();
        config.credential_keys = Some(CredentialEncryptionKey::for_test(label).into());
        let token = crate::auth::issue_agent_token(&config, &project_id, &runtime_id, None, None)
            .map(|minted| minted.token)
            .map_err(|(status, error)| {
                anyhow::anyhow!("token mint failed: {status}: {}", error.0.message)
            })?;
        let app = super::router().with_state(build_test_state(pool.clone(), config));
        let (status, body) =
            request_secrets(&app, &token, json!({ "job_id": job_id, "touch": false })).await?;
        anyhow::ensure!(status == StatusCode::OK, "{label}: {status}: {body}");
        Ok(body["env"].clone())
    }
    .await;

    let connection = pool.get().await?;
    let project_cleanup = connection
        .execute("delete from projects where id = $1", &[&project_id])
        .await;
    let user_cleanup = connection
        .execute("delete from auth.users where id = $1", &[&user_id])
        .await;
    let env = result?;
    project_cleanup?;
    user_cleanup?;
    Ok(env)
}

fn managed_model_env() -> Value {
    json!({
        "CODEX_MODEL": default_managed_ai_model_id(),
        "CODEX_MODEL_PROVIDER": "openai",
    })
}

#[tokio::test]
async fn credentialless_job_gets_managed_model_without_managed_ai_used() -> anyhow::Result<()> {
    let env = agent_secrets_env(
        "credentialless job managed model",
        LaneJob {
            has_credential: false,
            intent: "feature",
            names_agent: true,
        },
    )
    .await?;
    assert_eq!(
        env,
        managed_model_env(),
        "the agent's own model is replaced"
    );
    Ok(())
}

#[tokio::test]
async fn credentialless_job_without_agent_identity_still_gets_managed_model() -> anyhow::Result<()>
{
    let env = agent_secrets_env(
        "credentialless job without agent identity",
        LaneJob {
            has_credential: false,
            intent: "feature",
            names_agent: false,
        },
    )
    .await?;
    assert_eq!(env, managed_model_env());
    Ok(())
}

#[tokio::test]
async fn byo_job_keeps_agent_model() -> anyhow::Result<()> {
    let env = agent_secrets_env(
        "BYO job keeps agent model",
        LaneJob {
            has_credential: true,
            intent: "feature",
            names_agent: true,
        },
    )
    .await?;
    assert_eq!(env, json!({ "CODEX_MODEL": AGENT_MODEL }));

    let env = agent_secrets_env(
        "BYO job without agent identity",
        LaneJob {
            has_credential: true,
            intent: "feature",
            names_agent: false,
        },
    )
    .await?;
    assert_eq!(env, json!({}));
    Ok(())
}

#[tokio::test]
async fn terminal_command_job_gets_no_model_override() -> anyhow::Result<()> {
    let env = agent_secrets_env(
        "terminal command keeps agent model",
        LaneJob {
            has_credential: false,
            intent: "terminal_command",
            names_agent: true,
        },
    )
    .await?;
    assert_eq!(env, json!({ "CODEX_MODEL": AGENT_MODEL }));

    let env = agent_secrets_env(
        "terminal command without agent identity",
        LaneJob {
            has_credential: false,
            intent: "terminal_command",
            names_agent: false,
        },
    )
    .await?;
    assert_eq!(env, json!({}));
    Ok(())
}
