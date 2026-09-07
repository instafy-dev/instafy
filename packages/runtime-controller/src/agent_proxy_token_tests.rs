use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use bb8_postgres::PostgresConnectionManager;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use runtime_contracts::ProxyEnvelopePayload;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};

const PROXY_SECRET: &str = "inert-job-proxy-renewal-test-secret";

fn test_config() -> AppConfig {
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "job-proxy-renewal-test",
    );
    config.proxy_signing_secret = Some(PROXY_SECRET.to_string());
    config.proxy_base_url = Some("https://proxy.example.invalid/v1".to_string());
    config.proxy_token_ttl_seconds = 1800;
    config
}

fn scoped_token(
    config: &AppConfig,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    scopes: &[&str],
) -> anyhow::Result<String> {
    mint_scoped_token(
        config,
        ScopedTokenRequest {
            audience: runtime_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "runtime-agent".to_string()),
            subject: "inert-runtime-test".to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: runtime_id.map(|id| id.to_string()),
            protocol: None,
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map(|minted| minted.token)
    .map_err(|(status, error)| anyhow::anyhow!("test token mint: {status}: {}", error.0.message))
}

async fn renew(
    app: &Router,
    job_id: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let mut request = Request::builder()
        .method("POST")
        .uri(format!("/agent/jobs/{job_id}/proxy-token"));
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let body = match body {
        Some(body) => {
            request = request.header("Content-Type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app.clone().oneshot(request.body(body)?).await?;
    let status = response.status();
    let body = serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await?)?;
    Ok((status, body))
}

fn proxy_claims(envelope: &ProxyEnvelopePayload) -> anyhow::Result<Value> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&["proxy"]);
    validation.set_issuer(&["runtime-controller"]);
    Ok(decode::<Value>(
        &envelope.token,
        &DecodingKey::from_secret(PROXY_SECRET.as_bytes()),
        &validation,
    )?
    .claims)
}

#[tokio::test]
async fn proxy_token_renewal_requires_machine_lease_authority_before_database_access(
) -> anyhow::Result<()> {
    for strict_mode in [false, true] {
        let mut config = test_config();
        config.strict_mode = strict_mode;
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let unbound = scoped_token(&config, project_id, None, &["agent.lease"])?;
        let wrong_scope = scoped_token(&config, project_id, Some(runtime_id), &["prompt.execute"])?;
        let valid = scoped_token(&config, project_id, Some(runtime_id), &["agent.lease"])?;
        let mut expired_claims = crate::tokens::decode_scoped_token(&config, &valid, "test token")
            .map_err(|_| anyhow::anyhow!("decode inert test machine token"))?;
        expired_claims.iat = Utc::now().timestamp() - 600;
        expired_claims.exp = Utc::now().timestamp() - 120;
        let expired = encode(
            &Header::new(Algorithm::EdDSA),
            &expired_claims,
            &EncodingKey::from_ed_pem(test_origin_private_key().as_bytes())?,
        )?;
        let proxy = super::issue_proxy_envelope(
            &config,
            &project_id,
            &runtime_id,
            Some(&Uuid::new_v4()),
            None,
            None,
            None,
            None,
        )
        .expect("inert proxy envelope");
        let manager = PostgresConnectionManager::new_from_stringlike(
            "postgresql://postgres:postgres@127.0.0.1:1/postgres",
            crate::config::database_tls(),
        )?;
        let pool = bb8::Pool::builder().max_size(1).build_unchecked(manager);
        let app = super::router().with_state(build_test_state(pool, config));
        for token in [
            None,
            Some("invalid"),
            Some(&unbound),
            Some(&wrong_scope),
            Some(&expired),
            Some(&proxy.token),
        ] {
            let (status, body) = renew(&app, &Uuid::new_v4().to_string(), token, None).await?;
            anyhow::ensure!(
                status == StatusCode::UNAUTHORIZED,
                "strict={strict_mode}: {status}"
            );
            anyhow::ensure!(body.get("token").is_none());
        }
    }
    Ok(())
}

#[tokio::test]
async fn proxy_token_renewal_preserves_identity_and_rejects_inactive_leases() -> anyhow::Result<()>
{
    let pool = require_origin_test_pool("job proxy token renewal regression").await?;
    let project_id = Uuid::new_v4();
    let other_project_id = Uuid::new_v4();
    let owner_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let other_runtime_id = Uuid::new_v4();
    let foreign_runtime_id = Uuid::new_v4();
    let generation = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let credential_id = Uuid::new_v4();
    let payload = json!({
        "user_id": owner_id,
        "metadata": {
            "agent": {
                "handle": "renewal-test",
                "displayName": "Renewal Test",
                "description": "Inspect only the active project."
            }
        }
    });
    let lease_expiry = Utc::now() + Duration::minutes(10);

    let result: anyhow::Result<()> = async {
        ensure_test_user(&pool, &owner_id).await?;
        {
            let connection = pool.get().await?;
            for id in [project_id, other_project_id] {
                connection.execute(
                    "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
                    &[&id],
                ).await?;
            }
            for (id, project) in [(runtime_id, project_id), (other_runtime_id, project_id), (foreign_runtime_id, other_project_id)] {
                connection.execute(
                    "insert into runtimes (id, project_id, provider, status, capabilities)
                     values ($1, $2, 'self-hosted', 'ready', $3)",
                    &[&id, &project, &json!({
                        "agent": true,
                        "_instafySelfHostedAccess": {"mode": "private", "ownerUserId": owner_id},
                        "_instafyRuntimeTokenGeneration": generation,
                    })],
                ).await?;
            }
            connection.execute(
                "insert into runs (id, project_id, run_type, status) values ($1, $2, 'prompt', 'in_progress')",
                &[&run_id, &project_id],
            ).await?;
            connection.execute(
                "insert into user_credentials (id, user_id, kind, nonce_b64, ciphertext_b64)
                 values ($1, $2, 'openai_api_key', 'inert-nonce', 'inert-ciphertext')",
                &[&credential_id, &owner_id],
            ).await?;
            connection.execute(
                "insert into agent_jobs (id, project_id, run_id, credential_id, status,
                     leased_by_runtime_id, lease_expires_at, leased_at, payload)
                 values ($1, $2, $3, $4, 'leased', $5, $6, now(), $7)",
                &[&job_id, &project_id, &run_id, &credential_id, &runtime_id, &lease_expiry, &payload],
            ).await?;
        }

        for strict_mode in [false, true] {
            let mut config = test_config();
            config.strict_mode = strict_mode;
            let issue = |project: Uuid, runtime: Uuid, token_generation: Option<Uuid>, lease: Option<Uuid>| {
                crate::auth::issue_agent_token(&config, &project, &runtime, lease.as_ref(), token_generation)
                    .map(|minted| minted.token)
                    .map_err(|(status, error)| anyhow::anyhow!("test machine token: {status}: {}", error.0.message))
            };
            let token = issue(project_id, runtime_id, Some(generation), None)?;
            let rejected = [
                ("other runtime", issue(project_id, other_runtime_id, Some(generation), None)?, StatusCode::CONFLICT),
                ("other project", issue(other_project_id, foreign_runtime_id, Some(generation), None)?, StatusCode::CONFLICT),
                ("runtime belongs to another project", issue(project_id, foreign_runtime_id, Some(generation), None)?, StatusCode::UNAUTHORIZED),
                ("unregistered runtime", issue(project_id, Uuid::new_v4(), Some(generation), None)?, StatusCode::UNAUTHORIZED),
                ("missing generation", issue(project_id, runtime_id, None, None)?, StatusCode::UNAUTHORIZED),
                ("stale generation", issue(project_id, runtime_id, Some(Uuid::new_v4()), None)?, StatusCode::UNAUTHORIZED),
                ("retired runtime lease", issue(project_id, runtime_id, Some(generation), Some(Uuid::new_v4()))?, StatusCode::UNAUTHORIZED),
            ];
            let app = super::router().with_state(build_test_state(pool.clone(), config.clone()));
            for (case, rejected_token, expected) in rejected {
                let (status, body) = renew(&app, &job_id.to_string(), Some(&rejected_token), None).await?;
                anyhow::ensure!(status == expected, "{case}, strict={strict_mode}: {status}");
                anyhow::ensure!(body.get("token").is_none(), "{case} issued a proxy token");
            }
            let (status, _) = renew(&app, "not-a-uuid", Some(&token), None).await?;
            anyhow::ensure!(status == StatusCode::BAD_REQUEST);
            let (status, _) = renew(&app, &Uuid::new_v4().to_string(), Some(&token), None).await?;
            anyhow::ensure!(status == StatusCode::CONFLICT);

            let initial = super::issue_proxy_envelope(
                &config, &project_id, &runtime_id, Some(&run_id), Some(&credential_id),
                Some("renewal-test"), Some("Renewal Test"), Some("Inspect only the active project."),
            ).expect("initial lease proxy envelope");
            let mut initial_claims = proxy_claims(&initial)?;
            initial_claims.as_object_mut().unwrap().remove("iat");
            initial_claims.as_object_mut().unwrap().remove("exp");
            let before_row: Value = pool.get().await?.query_one(
                "select to_jsonb(j) from agent_jobs j where id = $1", &[&job_id],
            ).await?.get(0);
            let before = Utc::now();
            // Request bodies carry no authority, including forged identities and TTL.
            let (status, response) = renew(&app, &job_id.to_string(), Some(&token), Some(json!({
                "project_id": other_project_id, "runtime_id": other_runtime_id,
                "run_id": Uuid::new_v4(), "credential_id": Uuid::new_v4(),
                "agent_handle": "forged", "ttl_seconds": 86400,
            }))).await?;
            anyhow::ensure!(status == StatusCode::OK, "valid renewal, strict={strict_mode}: {status}");
            anyhow::ensure!(response.as_object().unwrap().len() == 3);
            let renewed: ProxyEnvelopePayload = serde_json::from_value(response)?;
            anyhow::ensure!(renewed.url == initial.url);
            let expires_at = chrono::DateTime::parse_from_rfc3339(renewed.expires_at.as_deref().unwrap())?;
            anyhow::ensure!(expires_at > before);
            let mut claims = proxy_claims(&renewed)?;
            let issued_at = claims["iat"].as_i64().unwrap();
            let expires = claims["exp"].as_i64().unwrap();
            anyhow::ensure!(issued_at >= before.timestamp());
            anyhow::ensure!(expires - issued_at == config.proxy_token_ttl_seconds);
            anyhow::ensure!(expires == expires_at.timestamp());
            claims.as_object_mut().unwrap().remove("iat");
            claims.as_object_mut().unwrap().remove("exp");
            anyhow::ensure!(claims == initial_claims, "renewal changed the job's proxy identity");
            let after_row: Value = pool.get().await?.query_one(
                "select to_jsonb(j) from agent_jobs j where id = $1", &[&job_id],
            ).await?.get(0);
            anyhow::ensure!(after_row == before_row, "proxy renewal mutated the job lease");

            for (case, owner, expiry, job_status, runtime_status, expected) in [
                ("unowned", None, Some(lease_expiry), "leased", "ready", StatusCode::CONFLICT),
                ("reassigned", Some(other_runtime_id), Some(lease_expiry), "leased", "ready", StatusCode::CONFLICT),
                ("expired", Some(runtime_id), Some(Utc::now() - Duration::seconds(1)), "leased", "ready", StatusCode::CONFLICT),
                ("missing expiry", Some(runtime_id), None, "leased", "ready", StatusCode::CONFLICT),
                ("queued", Some(runtime_id), Some(lease_expiry), "queued", "ready", StatusCode::CONFLICT),
                ("completed", Some(runtime_id), Some(lease_expiry), "completed", "ready", StatusCode::CONFLICT),
                ("failed", Some(runtime_id), Some(lease_expiry), "failed", "ready", StatusCode::CONFLICT),
                ("canceled", Some(runtime_id), Some(lease_expiry), "canceled", "ready", StatusCode::CONFLICT),
                ("stopped runtime", Some(runtime_id), Some(lease_expiry), "leased", "stopped", StatusCode::CONFLICT),
                ("draining runtime", Some(runtime_id), Some(lease_expiry), "leased", "draining", StatusCode::OK),
            ] {
                {
                    let connection = pool.get().await?;
                    connection.execute(
                        "update agent_jobs set leased_by_runtime_id = $2, lease_expires_at = $3, status = $4 where id = $1",
                        &[&job_id, &owner, &expiry, &job_status],
                    ).await?;
                    connection.execute("update runtimes set status = $2 where id = $1", &[&runtime_id, &runtime_status]).await?;
                }
                let (status, body) = renew(&app, &job_id.to_string(), Some(&token), None).await?;
                anyhow::ensure!(status == expected, "{case}, strict={strict_mode}: {status}");
                if status != StatusCode::OK {
                    anyhow::ensure!(body.get("token").is_none(), "{case} issued a proxy token");
                }
            }
            {
                let connection = pool.get().await?;
                connection.execute("update runtimes set status = 'ready' where id = $1", &[&runtime_id]).await?;
            }
            // A lease may expire while renewal waits for a concurrent job
            // operation. Checking the transaction's start time would accept it.
            {
                let mut connection = pool.get().await?;
                let transaction = connection.transaction().await?;
                transaction.execute(
                    "update agent_jobs set lease_expires_at = $2 where id = $1",
                    &[&job_id, &(Utc::now() + Duration::milliseconds(150))],
                ).await?;
                let waiting_app = app.clone();
                let waiting_token = token.clone();
                let waiting_job = job_id.to_string();
                let mut waiting = tokio::spawn(async move {
                    renew(&waiting_app, &waiting_job, Some(&waiting_token), None).await
                });
                anyhow::ensure!(tokio::time::timeout(
                    std::time::Duration::from_millis(250), &mut waiting,
                ).await.is_err(), "renewal passed a job row held by another transaction");
                transaction.commit().await?;
                let (status, body) = waiting.await??;
                anyhow::ensure!(status == StatusCode::CONFLICT);
                anyhow::ensure!(body.get("token").is_none());
                connection.execute(
                    "update agent_jobs set lease_expires_at = $2 where id = $1",
                    &[&job_id, &lease_expiry],
                ).await?;
            }
            config.proxy_signing_secret = None;
            config.controller_internal_token = None;
            let unavailable = super::router().with_state(build_test_state(pool.clone(), config));
            let (status, body) = renew(&unavailable, &job_id.to_string(), Some(&token), None).await?;
            anyhow::ensure!(status == StatusCode::SERVICE_UNAVAILABLE);
            anyhow::ensure!(body.get("token").is_none());
        }
        Ok(())
    }.await;

    let connection = pool.get().await?;
    let project_cleanup = connection
        .execute(
            "delete from projects where id = any($1::uuid[])",
            &[&vec![project_id, other_project_id]],
        )
        .await;
    let user_cleanup = connection
        .execute("delete from auth.users where id = $1", &[&owner_id])
        .await;
    result?;
    project_cleanup?;
    user_cleanup?;
    Ok(())
}
