//! `POST /agent/reply-draft` on the migrated database: a draft of a job the
//! runtime holds reaches the job's conversation as `run.reply_draft` and is
//! stored nowhere; a job it does not hold, or one outside a viewer's chat,
//! takes no draft.

use axum::body::{to_bytes, Body};
use axum::http::Request;
use tokio::sync::broadcast::error::TryRecvError;
use tower::ServiceExt;

use super::*;
use crate::config::{PgPool, RuntimeProviderConfig};
use crate::tests::{
    build_app_config, build_test_state, require_origin_test_pool, test_origin_private_key,
    test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};

const HOSTED_PROVIDER: &str = "instafy-cloud";

fn test_state(pool: &PgPool) -> AppState {
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "reply-draft",
    );
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

async fn add_runtime(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<Uuid> {
    let runtime_id = Uuid::new_v4();
    pool.get()
        .await?
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
                &format!("reply-draft-{runtime_id}"),
            ],
        )
        .await?;
    Ok(runtime_id)
}

async fn add_conversation(
    pool: &PgPool,
    project_id: &Uuid,
    internal: bool,
) -> anyhow::Result<Uuid> {
    let conversation_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into conversations (id, project_id, metadata, internal_purpose)
             values ($1, $2, '{}'::jsonb, $3)",
            &[
                &conversation_id,
                project_id,
                &internal.then_some("space_review"),
            ],
        )
        .await?;
    Ok(conversation_id)
}

/// A chat job of the space in `status`, leased by `runtime_id`.
async fn add_job(
    pool: &PgPool,
    project_id: &Uuid,
    runtime_id: &Uuid,
    status: &str,
    conversation_id: Option<Uuid>,
    run_id: Option<Uuid>,
) -> anyhow::Result<Uuid> {
    let job_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into agent_jobs (
                 id, project_id, status, intent, payload, conversation_id, run_id,
                 leased_by_runtime_id, leased_at, lease_expires_at, lease_attempts
             ) values (
                 $1, $2, $3, 'feature', '{}'::jsonb, $4, $5,
                 $6, now(), now() + interval '5 minutes', 1
             )",
            &[
                &job_id,
                project_id,
                &status,
                &conversation_id,
                &run_id,
                runtime_id,
            ],
        )
        .await?;
    Ok(job_id)
}

async fn post_draft(
    state: &AppState,
    bearer: &str,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let response = router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/reply-draft")
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

fn draft(job_id: &Uuid, seq: u64, text: &str) -> JsonValue {
    json!({ "job_id": job_id, "lease_attempt": 1, "segment": 1, "seq": seq, "text": text })
}

#[tokio::test]
async fn a_reply_draft_reaches_its_conversation_and_is_stored_nowhere() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("a_reply_draft_reaches_its_conversation_and_is_stored_nowhere")
            .await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        pool.get()
            .await?
            .execute(
                "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        let runtime_id = add_runtime(&pool, &project_id).await?;
        let other_runtime_id = add_runtime(&pool, &project_id).await?;
        let conversation_id = add_conversation(&pool, &project_id, false).await?;
        let internal_conversation_id = add_conversation(&pool, &project_id, true).await?;
        let run_id = Uuid::new_v4();
        pool.get()
            .await?
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status)
                 values ($1, $2, $3, 'prompt', 'in_progress')",
                &[&run_id, &project_id, &conversation_id],
            )
            .await?;
        let job_id = add_job(
            &pool,
            &project_id,
            &runtime_id,
            "leased",
            Some(conversation_id),
            Some(run_id),
        )
        .await?;

        let state = test_state(&pool);
        let bearer =
            crate::auth::issue_agent_token(&state.config, &project_id, &runtime_id, None, None)
                .map_err(|(status, error)| {
                    anyhow::anyhow!("agent bearer: {status} {}", error.0.message)
                })?
                .token;
        let mut events = state.events.subscribe();
        // A legacy project-wide token cannot borrow another machine's job,
        // including when self-hosted strict_mode is disabled.
        let unbound = crate::tokens::mint_scoped_token(&state.config, crate::tokens::ScopedTokenRequest {
            audience: runtime_id.to_string(), subject: "test-agent".to_string(), project_id: project_id.to_string(),
            origin_id: None, runtime_id: None, protocol: None, scopes: vec!["agent.message".to_string()],
            lease_id: None, run_id: None, prefer_runtime: None, ttl_seconds: Some(600),
        }).map_err(|(status, error)| anyhow::anyhow!("mint: {status} {}", error.0.message))?.token;
        let (status, _) = post_draft(&state, &unbound, draft(&job_id, 1, "Unbound")).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED);


        let (status, body) = post_draft(&state, &bearer, draft(&job_id, 1, "Hel")).await?;
        assert_eq!((status, body), (StatusCode::OK, json!({ "ok": true })));
        let event = events.try_recv()?;
        assert_eq!(event.kind, "run.reply_draft");
        assert_eq!(event.project_id, Some(project_id));
        assert_eq!(event.conversation_id, Some(conversation_id));
        assert_eq!(event.run_id, Some(run_id));
        assert_eq!(event.job_id, Some(job_id));
        assert_eq!(event.target_user_id, None);
        assert!(event
            .channels
            .contains(&format!("conversation:{conversation_id}")));
        assert_eq!(
            event.data,
            json!({
                "jobId": job_id,
                "runId": run_id,
                "conversationId": conversation_id,
                "attempt": 1,
                "segment": 1,
                "seq": 1,
                "text": "Hel",
            })
        );

        // Fast duplicate traffic is not published, but authorization is always
        // rechecked so cancellation cannot be bypassed by a cached route.
        let (status, _) = post_draft(&state, &bearer, draft(&job_id, 2, "Hell")).await?;
        assert_eq!(status, StatusCode::OK);
        assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let (status, _) = post_draft(&state, &bearer, draft(&job_id, 3, "Hello")).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(events.try_recv()?.data["text"], "Hello");

        let connection = pool.get().await?;
        let stored: i64 = connection
            .query_one(
                "select count(*) from conversation_messages where conversation_id = $1",
                &[&conversation_id],
            )
            .await?
            .get(0);
        assert_eq!(stored, 0, "a draft is never a message");
        let job_status: String = connection
            .query_one("select status from agent_jobs where id = $1", &[&job_id])
            .await?
            .get(0);
        assert_eq!(job_status, "leased");
        drop(connection);

        // Jobs this runtime does not hold, or whose replies no viewer sees.
        let queued = add_job(
            &pool,
            &project_id,
            &runtime_id,
            "queued",
            Some(conversation_id),
            None,
        )
        .await?;
        let elsewhere = add_job(
            &pool,
            &project_id,
            &other_runtime_id,
            "leased",
            Some(conversation_id),
            None,
        )
        .await?;
        let no_conversation =
            add_job(&pool, &project_id, &runtime_id, "leased", None, None).await?;
        let internal = add_job(
            &pool,
            &project_id,
            &runtime_id,
            "leased",
            Some(internal_conversation_id),
            None,
        )
        .await?;
        for (job, expected) in [
            (queued, StatusCode::NOT_FOUND),
            (elsewhere, StatusCode::NOT_FOUND),
            (no_conversation, StatusCode::BAD_REQUEST),
            (internal, StatusCode::FORBIDDEN),
        ] {
            let (status, body) = post_draft(&state, &bearer, draft(&job, 1, "Hel")).await?;
            assert_eq!(status, expected, "{job}: {body}");
        }
        // Even in a public conversation, a worker role never publishes a lead reply.
        let worker = add_job(&pool, &project_id, &runtime_id, "leased", Some(conversation_id), None).await?;
        pool.get().await?.execute("update agent_jobs set payload = $2 where id = $1", &[&worker, &PgJson(json!({"metadata": {"multiAgentPlan": {"role": " worker "}}}))]).await?;
        let (status, _) = post_draft(&state, &bearer, draft(&worker, 1, "Worker internals")).await?;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // Ambient evaluations/declines must remain silent before durable speech
        // commits the controller's participation and billing decision.
        for decision in ["agent_evaluation", "silent"] {
            let ambient = add_job(&pool, &project_id, &runtime_id, "leased", Some(conversation_id), Some(run_id)).await?;
            let payload = json!({"metadata": {"groupParticipation": {
                "decision": decision, "reason": "agent_declined", "enforcedBy": "runtime-controller"
            }}});
            pool.get().await?.execute("update agent_jobs set payload = $2 where id = $1", &[&ambient, &PgJson(payload)]).await?;
            let (status, _) = post_draft(&state, &bearer, draft(&ambient, 1, "Speculative speech")).await?;
            assert_eq!(status, StatusCode::OK);
            assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
        }

        // A re-lease of the same job/runtime cannot accept an earlier attempt's
        // delayed request, even though project, runtime and token still match.
        pool.get().await?.execute("update agent_jobs set lease_attempts = 2 where id = $1", &[&job_id]).await?;
        let (status, _) = post_draft(&state, &bearer, draft(&job_id, 99, "Old attempt")).await?;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let mut resumed = draft(&job_id, 1, "Resumed");
        resumed["lease_attempt"] = json!(2);
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let (status, _) = post_draft(&state, &bearer, resumed).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(events.try_recv()?.data["attempt"], 2);

        // Cancellation is observed immediately, with no authorization-cache grace.
        pool.get().await?.execute("update agent_jobs set status = 'canceled' where id = $1", &[&job_id]).await?;
        let mut canceled = draft(&job_id, 2, "Too late");
        canceled["lease_attempt"] = json!(2);
        let (status, _) = post_draft(&state, &bearer, canceled).await?;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // The request waits on a row lock until its lease expires. PostgreSQL's
        // transaction time is still before expiry; only a post-lock clock is safe.
        let expiring = add_job(&pool, &project_id, &runtime_id, "leased", Some(conversation_id), Some(run_id)).await?;
        let mut blocker = pool.get().await?;
        let held = blocker.transaction().await?;
        held.execute("update agent_jobs set lease_expires_at = clock_timestamp() + interval '150 milliseconds' where id = $1", &[&expiring]).await?;
        let request_state = state.clone();
        let request_bearer = bearer.clone();
        let pending = tokio::spawn(async move { post_draft(&request_state, &request_bearer, draft(&expiring, 1, "Expired while waiting")).await });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        held.commit().await?;
        let (status, _) = pending.await??;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let too_long = "x".repeat(128 * 1024 + 1);
        let (status, _) = post_draft(&state, &bearer, draft(&job_id, 4, &too_long)).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = post_draft(&state, "not-a-token", draft(&job_id, 5, "Hi")).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(
            matches!(events.try_recv(), Err(TryRecvError::Empty)),
            "a refused draft publishes nothing"
        );
        Ok(())
    })
    .await
}
