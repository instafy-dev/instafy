//! A turn that stops on a short upstream rate limit before it acted goes back to the queue, at
//! most `MAX_RERUNS` times, through `/agent/complete` (`turn_rate_limit_retry`).

use super::*;

const RATE_LIMITED: &str = "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 7.632s.";

async fn complete_failed(
    app: &axum::Router,
    token: &str,
    job_id: Uuid,
    error: &str,
) -> anyhow::Result<()> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/complete")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(
                    json!({ "job_id": job_id, "outcome": "failed", "error_message": error, "artifacts": [] })
                        .to_string(),
                ))?,
        )
        .await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    anyhow::ensure!(
        status == StatusCode::OK,
        "complete returned {status}: {}",
        String::from_utf8_lossy(&body)
    );
    Ok(())
}

struct TurnState {
    job_status: String,
    error: Option<String>,
    payload: serde_json::Value,
    run_status: String,
    run_stage: Option<String>,
    run_metadata: Option<serde_json::Value>,
    failure_messages: i64,
}

async fn turn_state(pool: &PgPool, job_id: Uuid) -> anyhow::Result<TurnState> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select aj.status, aj.error_message, aj.payload, r.status as run_status,
                    r.progress_stage, r.metadata as run_metadata,
                    (select count(*) from conversation_messages m
                     where m.conversation_id = aj.conversation_id
                       and m.role = 'assistant'
                       and coalesce(m.metadata #>> '{jobId}', '') = aj.id::text
                       and coalesce(m.metadata #>> '{messageType}', '') not in ('command_execution', 'web_search')
                    ) as failure_messages
             from agent_jobs aj join runs r on r.id = aj.run_id
             where aj.id = $1",
            &[&job_id],
        )
        .await?;
    Ok(TurnState {
        job_status: row.get("status"),
        error: row.get("error_message"),
        payload: row.get::<_, PgJson<serde_json::Value>>("payload").0,
        run_status: row.get("run_status"),
        run_stage: row.get("progress_stage"),
        run_metadata: row
            .get::<_, Option<PgJson<serde_json::Value>>>("run_metadata")
            .map(|json| json.0),
        failure_messages: row.get("failure_messages"),
    })
}

async fn insert_tool_message(
    space: &ManagedSpace,
    conversation_id: Uuid,
    job_id: Uuid,
    details: serde_json::Value,
) -> anyhow::Result<()> {
    space
        .pool
        .get()
        .await?
        .execute(
            "insert into conversation_messages (id, project_id, conversation_id, role, content, metadata)
             values ($4, $1, $2, 'assistant', 'ran a command', $3)",
            &[
                &space.project_id,
                &conversation_id,
                &PgJson(json!({ "jobId": job_id, "messageType": "command_execution", "details": details })),
                &Uuid::new_v4(),
            ],
        )
        .await?;
    Ok(())
}

/// The lead's planning turn of r10-pacing3, rate-limited on its first request: it goes back to
/// the queue instead of failing, with no failure posted and its run shown waiting; no runtime
/// takes it before the hold; the pacing learns the rate limit; a rate limit on a re-run puts it
/// back again (run r11-pacing), and the one after its last re-run fails it.
/// A turn that acted, or stopped on a spent usage limit, fails as before.
#[tokio::test]
async fn a_lead_turn_rate_limited_before_it_acted_runs_again_after_the_wait() -> anyhow::Result<()>
{
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping turn rate-limit retry test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let space = ManagedSpace::seed(pool.clone(), "turn-rate-limit-retry").await?;
    let pacing_key = crate::upstream_pacing::platform_project_key(&space.project_id);
    let clear_pacing = || {
        let pool = pool.clone();
        let key = pacing_key.clone();
        async move {
            pool.get()
                .await?
                .execute(
                    "delete from upstream_pacing where upstream_key = $1",
                    &[&key],
                )
                .await?;
            anyhow::Ok(())
        }
    };
    let test_result: anyhow::Result<()> = async {
        clear_pacing().await?;
        let state = build_test_state(pool.clone(), space.config("turn-rate-limit-retry"));
        let app = crate::agent::router().with_state(state.clone());
        let token = crate::auth::issue_agent_token(
            &state.config,
            &space.project_id,
            &space.hosted_runtime_id,
            None,
            None,
        )
        .map_err(|error| controller_error("issue agent token", error))?
        .token;

        // 1. the planning turn ran only the runtime's routing pre-observation, then stopped
        let (conversation, _, lead, _) = insert_leased_plan_job(
            &space,
            space.hosted_runtime_id,
            None,
            json!({ "agent": { "handle": "octo" } }),
        )
        .await?;
        insert_tool_message(
            &space,
            conversation,
            lead,
            json!({ "source": "routing_pre_observation" }),
        )
        .await?;
        complete_failed(&app, &token, lead, RATE_LIMITED).await?;
        let requeued = turn_state(&pool, lead).await?;
        assert_eq!(requeued.job_status, "queued");
        assert_eq!(requeued.error, None);
        assert_eq!(requeued.payload["requeuedReason"], "upstream_rate_limit");
        let retry = &requeued.payload["rateLimitRetry"];
        assert_eq!(retry["waitMs"], 7_632);
        let hold_ms = retry["holdMs"].as_u64().expect("holdMs");
        assert!((7_632..=7_632 + 3_816).contains(&hold_ms), "{hold_ms}");
        assert!(retry["heldUntilMs"].is_u64(), "{retry}");
        assert_eq!(retry["error"], RATE_LIMITED);
        assert_eq!(retry["attempts"], 1);
        assert_eq!(requeued.run_status, "queued", "the run waits again");
        assert_eq!(requeued.run_stage.as_deref(), Some("requeued"));
        assert_eq!(
            requeued.run_metadata.as_ref().expect("run metadata")["interruption"]["reason"],
            "upstream_rate_limit"
        );
        assert_eq!(requeued.failure_messages, 0, "no failure is posted");
        let cooldown: f64 = pool
            .get()
            .await?
            .query_one(
                "select extract(epoch from cooldown_until - now())::double precision
                 from upstream_pacing where upstream_key = $1",
                &[&pacing_key],
            )
            .await?
            .get(0);
        assert!((5.0..=7.7).contains(&cooldown), "the pacing learned it: {cooldown}");

        // 2. no runtime takes it before the hold; after it, it runs again
        assert_eq!(
            lease_all_jobs(&app, &state.config, space.project_id, space.hosted_runtime_id, None)
                .await?,
            Vec::<Uuid>::new(),
            "held"
        );
        let end_hold = || {
            let pool = pool.clone();
            async move {
                pool.get()
                    .await?
                    .execute(
                        "update agent_jobs
                         set payload = jsonb_set(payload, '{rateLimitRetry,heldUntilMs}',
                             to_jsonb(floor(extract(epoch from now()) * 1000)::bigint - 1))
                         where id = $1",
                        &[&lead],
                    )
                    .await?;
                anyhow::Ok(())
            }
        };
        end_hold().await?;
        assert_eq!(
            lease_all_jobs(&app, &state.config, space.project_id, space.hosted_runtime_id, None)
                .await?,
            vec![lead]
        );
        let resumed = turn_state(&pool, lead).await?;
        assert_eq!(resumed.job_status, "leased");
        assert_eq!(resumed.run_status, "in_progress");

        // 3. a re-run that is rate limited again goes back again (r11-pacing: the other teams had
        //    used up the window), until its last re-run
        for attempt in 2..=crate::turn_rate_limit_retry::MAX_RERUNS {
            complete_failed(&app, &token, lead, RATE_LIMITED).await?;
            let again = turn_state(&pool, lead).await?;
            assert_eq!(again.job_status, "queued", "re-run {attempt}");
            assert_eq!(again.payload["rateLimitRetry"]["attempts"], attempt);
            assert_eq!(again.run_status, "queued");
            assert_eq!(again.failure_messages, 0, "no failure is posted");
            end_hold().await?;
            assert_eq!(
                lease_all_jobs(&app, &state.config, space.project_id, space.hosted_runtime_id, None)
                    .await?,
                vec![lead]
            );
        }

        // the rate limit after its last re-run fails it
        complete_failed(&app, &token, lead, RATE_LIMITED).await?;
        let failed = turn_state(&pool, lead).await?;
        assert_eq!(failed.job_status, "failed");
        assert_eq!(failed.run_status, "failed");
        assert_eq!(failed.error.as_deref(), Some(RATE_LIMITED));
        assert_eq!(failed.failure_messages, 1, "the failure is posted");

        // 4. a turn that ran a command, or stopped on a spent usage limit, fails as before
        let (conversation, _, acted, _) = insert_leased_plan_job(
            &space,
            space.hosted_runtime_id,
            None,
            json!({ "agent": { "handle": "octo" } }),
        )
        .await?;
        insert_tool_message(&space, conversation, acted, json!({})).await?;
        complete_failed(&app, &token, acted, RATE_LIMITED).await?;
        assert_eq!(turn_state(&pool, acted).await?.job_status, "failed", "acted");
        let (_, _, spent, _) = insert_leased_plan_job(
            &space,
            space.hosted_runtime_id,
            None,
            json!({ "agent": { "handle": "octo" } }),
        )
        .await?;
        complete_failed(
            &app,
            &token,
            spent,
            "rate limit exceeded: The upstream plan usage limit was reached. (usage_limit_reached, 429). Please try again in 7s.",
        )
        .await?;
        assert_eq!(turn_state(&pool, spent).await?.job_status, "failed", "usage limit");
        Ok(())
    }
    .await;
    let pacing_cleanup = clear_pacing().await;
    let space_cleanup = space.cleanup().await;
    test_result?;
    pacing_cleanup?;
    space_cleanup
}
