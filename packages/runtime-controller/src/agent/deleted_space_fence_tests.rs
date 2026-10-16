//! The agent routes of a runtime whose space was deleted, on the migrated
//! database: a lease poll and every general agent call are gone, a heartbeat
//! conflicts so that the agent ends its turn, and only the agent's own stop
//! and a planning job's receipt still get through.

use axum::body::{to_bytes, Body};
use axum::http::Request;
use tower::ServiceExt;

use super::*;
use crate::config::{PgPool, RuntimeProviderConfig};
use crate::projects::SPACE_DELETED_CODE;
use crate::tests::{
    build_app_config, build_test_state, pool_gets, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};

const HOSTED_PROVIDER: &str = "instafy-cloud";

fn test_state(pool: &PgPool, key_id: &str) -> AppState {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), key_id);
    config.strict_mode = false;
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: HOSTED_PROVIDER.to_string(),
        display_name: "Instafy Cloud".to_string(),
        kind: "noop".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    }];
    build_test_state(pool.clone(), config)
}

/// A space with a ready hosted runtime seen a moment ago, which holds no
/// lease generation.
async fn seed_space_with_runtime(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<Uuid> {
    let runtime_id = Uuid::new_v4();
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
            &[project_id],
        )
        .await?;
    connection
        .execute(
            "insert into runtimes (
                 id, project_id, provider, status, endpoint_url, task_ref,
                 idle_ttl_seconds, last_seen_at, capabilities
             ) values (
                 $1, $2, $3, 'ready', 'http://runtime.invalid', $4, 600, now(),
                 '{\"agent\": true}'::jsonb
             )",
            &[
                &runtime_id,
                project_id,
                &HOSTED_PROVIDER,
                &format!("deleted-space-fence-{runtime_id}"),
            ],
        )
        .await?;
    Ok(runtime_id)
}

async fn mark_deleted(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "update projects set status = 'deleted' where id = $1",
            &[project_id],
        )
        .await?;
    Ok(())
}

/// A job of the space, `status`, leased by `runtime_id` at attempt 1.
async fn add_job(
    pool: &PgPool,
    project_id: &Uuid,
    runtime_id: &Uuid,
    status: &str,
    planning_receipt_state: Option<JsonValue>,
) -> anyhow::Result<Uuid> {
    let job_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into agent_jobs (
                 id, project_id, status, intent, payload, leased_by_runtime_id,
                 leased_at, lease_expires_at, lease_attempts, planning_receipt_state
             ) values (
                 $1, $2, $3, 'terminal_command', '{}'::jsonb, $4,
                 now(), now() + interval '5 minutes', 1, $5
             )",
            &[
                &job_id,
                project_id,
                &status,
                runtime_id,
                &planning_receipt_state.map(PgJson),
            ],
        )
        .await?;
    Ok(job_id)
}

async fn job_lease_expires_at(
    pool: &PgPool,
    job_id: &Uuid,
) -> anyhow::Result<Option<DateTime<Utc>>> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select lease_expires_at from agent_jobs where id = $1",
            &[job_id],
        )
        .await?
        .get(0))
}

fn agent_bearer(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: Option<&Uuid>,
) -> anyhow::Result<String> {
    Ok(
        crate::auth::issue_agent_token(&state.config, project_id, runtime_id, lease_id, None)
            .map_err(|(status, error)| {
                anyhow::anyhow!("issue the agent bearer: {status} {}", error.0.message)
            })?
            .token,
    )
}

async fn post(
    state: &AppState,
    path: &str,
    bearer: &str,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let response = router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {bearer}"),
                )
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let body = if bytes.is_empty() {
        JsonValue::Null
    } else {
        serde_json::from_slice(&bytes)?
    };
    Ok((status, body))
}

fn assert_space_deleted(
    (status, body): &(StatusCode, JsonValue),
    expected_status: StatusCode,
    call: &str,
) {
    assert_eq!(*status, expected_status, "{call}: {body}");
    assert_eq!(body["code"], SPACE_DELETED_CODE, "{call}: {body}");
    assert_eq!(body["message"], "This space was deleted.", "{call}: {body}");
}

fn assert_refusal_is_space_deleted(
    result: Result<(), (StatusCode, Json<ApiError>)>,
    expected_status: StatusCode,
    call: &str,
) {
    let (status, Json(error)) = result.expect_err(call);
    assert_eq!(status, expected_status, "{call}: {}", error.message);
    assert_eq!(error.code.as_deref(), Some(SPACE_DELETED_CODE), "{call}");
}

/// A deleted space's runtime polling for work is told the space is gone,
/// from the one read of an idle poll, whether or not a job of the space is
/// still queued. A token of an earlier generation still gets the 401 it
/// renews on, and the leasing transaction refuses the space the same way.
#[tokio::test]
async fn a_deleted_space_lease_poll_is_gone() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a_deleted_space_lease_poll_is_gone").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let runtime_id = seed_space_with_runtime(&pool, &project_id).await?;
        let state = test_state(&pool, "deleted-space-lease");
        let bearer = agent_bearer(&state, &project_id, &runtime_id, None)?;
        let lease_body = json!({ "max": 1, "lease_seconds": 120 });

        let (status, body) = post(&state, "/agent/lease", &bearer, lease_body.clone()).await?;
        assert_eq!((status, body), (StatusCode::OK, json!({ "jobs": [] })));

        mark_deleted(&pool, &project_id).await?;
        let gets_before = pool_gets(&pool);
        let idle = post(&state, "/agent/lease", &bearer, lease_body.clone()).await?;
        assert_space_deleted(&idle, StatusCode::GONE, "idle lease poll");
        assert_eq!(
            pool_gets(&pool) - gets_before,
            1,
            "the refusal comes from the idle poll's one read"
        );

        let queued = Uuid::new_v4();
        pool.get()
            .await?
            .execute(
                "insert into agent_jobs (id, project_id, status, intent, payload)
                 values ($1, $2, 'queued', 'terminal_command', '{}'::jsonb)",
                &[&queued, &project_id],
            )
            .await?;
        let with_work = post(&state, "/agent/lease", &bearer, lease_body.clone()).await?;
        assert_space_deleted(&with_work, StatusCode::GONE, "lease poll with queued work");
        let status: String = pool
            .get()
            .await?
            .query_one("select status from agent_jobs where id = $1", &[&queued])
            .await?
            .get(0);
        assert_eq!(status, "queued", "nothing is leased in a deleted space");

        let stale = agent_bearer(&state, &project_id, &runtime_id, Some(&Uuid::new_v4()))?;
        let (status, body) = post(&state, "/agent/lease", &stale, lease_body).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(
            body["message"],
            "agent token runtime lease scope is no longer active"
        );

        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let leasing =
            ensure_runtime_can_lease(&state, &transaction, &project_id, &runtime_id, None, None)
                .await
                .map(|_| ());
        transaction.rollback().await?;
        assert_refusal_is_space_deleted(leasing, StatusCode::GONE, "leasing transaction");
        Ok(())
    })
    .await
}

/// A heartbeat for a turn in a deleted space conflicts, the one refusal on
/// which the agent ends the turn instead of renewing its token, and does not
/// extend the job's lease.
#[tokio::test]
async fn a_deleted_space_heartbeat_conflicts() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a_deleted_space_heartbeat_conflicts").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let runtime_id = seed_space_with_runtime(&pool, &project_id).await?;
        let job_id = add_job(&pool, &project_id, &runtime_id, "leased", None).await?;
        let state = test_state(&pool, "deleted-space-heartbeat");
        let bearer = agent_bearer(&state, &project_id, &runtime_id, None)?;
        let heartbeat = json!({ "job_id": job_id, "extend_seconds": 60 });

        let (status, body) = post(&state, "/agent/heartbeat", &bearer, heartbeat.clone()).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let renewed = job_lease_expires_at(&pool, &job_id).await?;

        mark_deleted(&pool, &project_id).await?;
        let refused = post(&state, "/agent/heartbeat", &bearer, heartbeat).await?;
        assert_space_deleted(&refused, StatusCode::CONFLICT, "heartbeat");
        assert_eq!(job_lease_expires_at(&pool, &job_id).await?, renewed);

        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let checked = ensure_runtime_can_heartbeat(
            &state,
            &transaction,
            &project_id,
            &runtime_id,
            None,
            None,
        )
        .await;
        transaction.rollback().await?;
        assert_refusal_is_space_deleted(checked, StatusCode::CONFLICT, "heartbeat check");
        Ok(())
    })
    .await
}

/// Every general agent call of a deleted space is gone, a message among
/// them, while the agent's own stop and its release retries stay open: a
/// runtime quarantined in `cleanup_pending` still finishes its stop.
#[tokio::test]
async fn a_deleted_space_refuses_general_agent_calls_but_not_its_stop() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a_deleted_space_refuses_general_agent_calls").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let runtime_id = seed_space_with_runtime(&pool, &project_id).await?;
        let job_id = add_job(&pool, &project_id, &runtime_id, "leased", None).await?;
        let state = test_state(&pool, "deleted-space-general-calls");
        let bearer = agent_bearer(&state, &project_id, &runtime_id, None)?;
        mark_deleted(&pool, &project_id).await?;

        let message = post(
            &state,
            "/agent/message",
            &bearer,
            json!({ "job_id": job_id, "content": "still here" }),
        )
        .await?;
        assert_space_deleted(&message, StatusCode::GONE, "agent message");

        let context = TokenContext {
            project_id,
            runtime_id: Some(runtime_id),
            lease_id: None,
            runtime_generation: None,
        };
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let general =
            ensure_agent_token_matches_runtime_lease(&state, &transaction, &context, &runtime_id)
                .await;
        let stop = ensure_agent_token_matches_runtime_lease_for_stop(
            &state,
            &transaction,
            &context,
            &runtime_id,
        )
        .await;
        transaction.rollback().await?;
        assert_refusal_is_space_deleted(general, StatusCode::GONE, "general agent call");
        stop.map_err(|(status, error)| {
            anyhow::anyhow!(
                "the agent's own stop was refused: {status} {}",
                error.0.message
            )
        })?;

        // A stop quarantined while the provider releases the machine.
        let lease_id = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into runtime_leases
                        (id, project_id, runtime_id, status, requested_at, launched_at)
                     values ($1, $2, $3, 'cleanup_pending', now(), now())",
                    &[&lease_id, &project_id, &runtime_id],
                )
                .await?;
            connection
                .execute(
                    "update runtimes set status = 'requested', active_lease_id = $2 where id = $1",
                    &[&runtime_id, &lease_id],
                )
                .await?;
        }
        let quarantined = TokenContext {
            lease_id: Some(lease_id),
            ..context
        };
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let retry = ensure_agent_token_matches_runtime_lease_for_stop(
            &state,
            &transaction,
            &quarantined,
            &runtime_id,
        )
        .await;
        transaction.rollback().await?;
        retry.map_err(|(status, error)| {
            anyhow::anyhow!(
                "the release retry was refused: {status} {}",
                error.0.message
            )
        })?;
        Ok(())
    })
    .await
}

/// The receipt of a planning job the controller already ended is still
/// taken for a deleted space, so its usage is billed; any other completion
/// is gone.
#[tokio::test]
async fn a_deleted_space_still_takes_a_planning_receipt() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a_deleted_space_still_takes_a_planning_receipt").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let runtime_id = seed_space_with_runtime(&pool, &project_id).await?;
        let planning_job = add_job(
            &pool,
            &project_id,
            &runtime_id,
            "failed",
            Some(json!({
                "state": "pending",
                "runtimeId": runtime_id,
                "leaseAttempt": 1,
                "runtimeLeaseId": null,
                "runtimeGeneration": null,
            })),
        )
        .await?;
        let leased_job = add_job(&pool, &project_id, &runtime_id, "leased", None).await?;
        let state = test_state(&pool, "deleted-space-completion");
        let bearer = agent_bearer(&state, &project_id, &runtime_id, None)?;
        mark_deleted(&pool, &project_id).await?;

        let (status, body) = post(
            &state,
            "/agent/complete",
            &bearer,
            json!({ "job_id": planning_job, "outcome": "succeeded", "artifacts": [] }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let receipt: JsonValue = pool
            .get()
            .await?
            .query_one(
                "select planning_receipt_state from agent_jobs where id = $1",
                &[&planning_job],
            )
            .await?
            .get(0);
        assert_eq!(receipt["state"], "received");

        let completion = post(
            &state,
            "/agent/complete",
            &bearer,
            json!({ "job_id": leased_job, "outcome": "succeeded", "artifacts": [] }),
        )
        .await?;
        assert_space_deleted(&completion, StatusCode::GONE, "completion");
        let status: String = pool
            .get()
            .await?
            .query_one(
                "select status from agent_jobs where id = $1",
                &[&leased_job],
            )
            .await?
            .get(0);
        assert_eq!(status, "leased");
        Ok(())
    })
    .await
}
