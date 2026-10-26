//! Use the real checkpoint dispatcher and completion/cancellation endpoints. An
//! early lead must finish before a final lead can publish a newer group snapshot.

use super::*;
use crate::background_loops::TickConnection;

async fn final_checkpoints(
    pool: &PgPool,
    conversation: Uuid,
) -> anyhow::Result<Vec<tokio_postgres::Row>> {
    Ok(pool.get().await?.query(
        "select id, created_at, payload from agent_jobs where conversation_id=$1
         and payload #>> '{metadata,multiAgentPlan,role}'='lead_continuation'
         and coalesce(payload #>> '{metadata,multiAgentPlan,checkpointKind}','') <> 'early_failure'",
        &[&conversation],
    ).await?)
}

async fn post_checkpoint_request(
    app: axum::Router,
    uri: &str,
    token: &str,
    body: serde_json::Value,
) -> anyhow::Result<()> {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    anyhow::ensure!(
        status == StatusCode::OK,
        "{uri} returned {status}: {}",
        String::from_utf8_lossy(&body)
    );
    Ok(())
}

#[tokio::test]
async fn final_checkpoint_waits_for_early_lead_and_recovers_every_terminal_handoff(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping checkpoint ordering regression: TEST_DATABASE_URL not set");
        return Ok(());
    };
    for ending in [
        "succeeded",
        "failed",
        "canceled",
        "expired_recovery",
        "cancelled_recovery",
        "stopped",
    ] {
        let space = ManagedSpace::seed(pool.clone(), "checkpoint-order").await?;
        let result: anyhow::Result<()> = async {
            let state = build_test_state(pool.clone(), space.config("checkpoint-order"));
            let group = Uuid::new_v4();
            let clock = crate::multi_agent_plan::team_clock::TeamClock {
                started_at: chrono::Utc::now(), budget: std::time::Duration::from_secs(3600),
            }.to_json();
            let parent_job = Uuid::new_v4();
            let plan = json!({"groupId":group,"role":"worker","mode":"read_only",
                "parentJobId": parent_job, "teamClock": clock, "handoffPaths":["reports/verified.md"],
                "parentRuntimeId":space.hosted_runtime_id,
                "lead":{"leadHandle":"octo","continuationPrompt":"Summarize the verified results.","expectedReportFormat":"A short table"}});
            let (conversation, first, mut first_payload) = insert_finished_plan_lane(&space, None, "alpha", plan.clone(), json!({})).await?;
            let (_, second, second_payload) = insert_finished_plan_lane(&space, Some(conversation), "beta", plan, json!({})).await?;
            let session = Uuid::new_v4();
            first_payload["session_id"] = json!(session);
            first_payload["metadata"]["runtimePreference"] = json!({"runtimeId":space.hosted_runtime_id,"source":"multi_agent_plan_parent"});
            let connection = pool.get().await?;
            connection.execute("update agent_jobs set payload=$2,session_id=$3 where id=$1", &[&first,&PgJson(first_payload.clone()),&session]).await?;
            connection.execute("update conversations set session_id=$2 where id=$1", &[&conversation,&session]).await?;
            connection.execute("update agent_jobs set status='failed', outcome='failed', error_message='Missing input' where id=$1", &[&first]).await?;
            connection.execute("update agent_jobs set status='leased', completed_at=null where id=$1", &[&second]).await?;
            drop(connection);
            assert!(crate::multi_agent_plan::maybe_enqueue_lead_continuation_after_completion(&state, first, &first_payload).await
                .map_err(|e| controller_error("early checkpoint", e))?);
            let row = pool.get().await?.query_one(
                "select id,payload from agent_jobs where conversation_id=$1
                 and payload #>> '{metadata,multiAgentPlan,checkpointKind}'='early_failure'",
                &[&conversation],
            ).await?;
            let early: Uuid = row.get("id");
            let early_payload = row.get::<_, PgJson<serde_json::Value>>("payload").0;
            assert!(early_payload["prompt_text"].as_str().unwrap().contains("RUNNING"));

            // This was the live race: the last worker ends before the queued or
            // running early lead. Neither its callback nor recovery may queue final.
            pool.get().await?.execute(
                "update agent_jobs set status='completed',outcome='succeeded',summary='LATEST VERIFIED RESULT',completed_at=now() where id=$1",
                &[&second],
            ).await?;
            for status in ["queued", "leased"] {
                pool.get().await?.execute(
                    "update agent_jobs set status=$2,leased_by_runtime_id=$3,leased_at=now(),lease_expires_at=now()+interval '5 minutes' where id=$1",
                    &[&early, &status, &space.hosted_runtime_id],
                ).await?;
                assert!(!crate::multi_agent_plan::maybe_enqueue_lead_continuation_after_completion(&state, second, &second_payload).await
                    .map_err(|e| controller_error("last worker checkpoint", e))?);
                crate::runtime::recover_deferred_plan_checkpoints(&state, &mut TickConnection::new(&pool)).await?;
                assert!(final_checkpoints(&pool, conversation).await?.is_empty(), "{ending}: active early lead cannot be overtaken");
            }

            let queued_send = Uuid::new_v4();
            if ending == "canceled" {
                pool.get().await?.execute(
                    "insert into conversation_send_queue(id,project_id,conversation_id,user_id,status,request)
                     values($1,$2,$3,$4,'queued',$5)",
                    &[&queued_send,&space.project_id,&conversation,&space.owner_user_id,&PgJson(json!({
                        "promptText":"Now summarize a separate document.","intent":"feature",
                        "metadata":{"agentSelection":{"active":["octo"],"mentions":[]}},
                        "runtimeId":space.hosted_runtime_id,
                    }))],
                ).await?;
            }
            let artifacts = json!([{"kind":"codex/run-log","events":[{
                "type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}
            }]}]);
            if matches!(ending, "succeeded" | "failed") {
                let token = crate::auth::issue_agent_token(&state.config, &space.project_id, &space.hosted_runtime_id, None, None)
                    .map_err(|e| controller_error("completion token", e))?.token;
                post_checkpoint_request(crate::agent::router().with_state(state.clone()), "/agent/complete", &token,
                    json!({"job_id":early,"outcome":ending,"summary":"EARLY RESULT",
                        "error_message":if ending=="failed" {Some("Early review failed")} else {None},
                        "artifacts":artifacts})).await?;
                let stored = pool.get().await?.query_one("select artifacts from agent_jobs where id=$1", &[&early]).await?;
                assert_eq!(stored.get::<_, PgJson<serde_json::Value>>(0).0, artifacts, "usage and diagnostics survive the handoff");
            } else if matches!(ending, "expired_recovery" | "cancelled_recovery") {
                // A restart lost the post-commit callback. Only the idle-sweep
                // recovery sees this terminal lead; no worker callback is replayed.
                let terminal_status = if ending == "expired_recovery" { "expired" } else { "cancelled" };
                pool.get().await?.execute("update agent_jobs set status=$2,outcome=$2,completed_at=now() where id=$1", &[&early,&terminal_status]).await?;
                // More than one recovery batch of orphaned older checkpoints
                // must not consume the batch and starve this valid group.
                pool.get().await?.execute(
                    "insert into agent_jobs(project_id,conversation_id,status,completed_at,payload)
                     select $1,$2,'completed',now()-interval '1 day',
                       jsonb_set($3,'{metadata,multiAgentPlan,groupId}',to_jsonb(gen_random_uuid()::text))
                     from generate_series(1,40)",
                    &[&space.project_id,&conversation,&PgJson(early_payload.clone())],
                ).await?;
                crate::runtime::recover_deferred_plan_checkpoints(&state, &mut TickConnection::new(&pool)).await?;
            } else {
                let token = crate::auth::issue_controller_token(&state.config, &space.owner_user_id)
                    .map_err(|e| controller_error("cancel token", e))?.token;
                let uri = if ending == "stopped" { format!("/jobs/plan-groups/{group}/cancel") }
                    else { format!("/jobs/{early}/cancel") };
                post_checkpoint_request(crate::conversations::router().with_state(state.clone()), &uri, &token, json!({})).await?;
            }

            if ending != "stopped" {
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
                let final_rows = loop {
                    let rows = final_checkpoints(&pool, conversation).await?;
                    if !rows.is_empty() { break rows; }
                    anyhow::ensure!(tokio::time::Instant::now() < deadline, "{ending}: terminal early lead stranded final");
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                };
                assert_eq!(final_rows.len(), 1);
                let payload = final_rows[0].get::<_, PgJson<serde_json::Value>>("payload").0;
                assert!(payload["prompt_text"].as_str().unwrap().contains("LATEST VERIFIED RESULT"), "final uses a fresh group snapshot");
                for key in ["lead", "teamClock", "parentJobId", "handoffPaths"] {
                    assert_eq!(payload["metadata"]["multiAgentPlan"][key], early_payload["metadata"]["multiAgentPlan"][key], "final retains {key}");
                }
                assert_eq!(payload["user_id"], early_payload["user_id"]);
                assert_eq!(early_payload["session_id"], json!(session));
                assert_eq!(payload["session_id"], json!(session));
                assert_eq!(payload["metadata"]["runtimePreference"]["runtimeId"], json!(space.hosted_runtime_id));
                if matches!(ending, "succeeded" | "failed") {
                    let published: chrono::DateTime<chrono::Utc> = pool.get().await?.query_one(
                        "select created_at from conversation_messages where conversation_id=$1 and metadata->>'jobId'=$2
                         and metadata->>'source'='agent' and metadata->>'outcome' in ('succeeded','failed') order by created_at desc limit 1",
                        &[&conversation,&early.to_string()],
                    ).await?.get(0);
                    assert!(published <= final_rows[0].get::<_, chrono::DateTime<chrono::Utc>>("created_at"), "early answer committed before final dispatch");
                }
            }
            // Duplicate callbacks, cancellation recovery and the next idle tick
            // cannot create another final, nor restart an explicitly stopped plan.
            crate::multi_agent_plan::maybe_enqueue_lead_continuation_after_completion(&state, early, &early_payload).await
                .map_err(|e| controller_error("replayed early completion", e))?;
            crate::multi_agent_plan::checkpoint_plan_groups_for_jobs(&state, &[first, second, early]).await
                .map_err(|e| controller_error("checkpoint recovery", e))?;
            crate::runtime::recover_deferred_plan_checkpoints(&state, &mut TickConnection::new(&pool)).await?;
            let final_rows = final_checkpoints(&pool, conversation).await?;
            assert_eq!(final_rows.len(), usize::from(ending != "stopped"));
            if ending == "canceled" {
                let status: String = pool.get().await?.query_one("select status from conversation_send_queue where id=$1", &[&queued_send]).await?.get(0);
                assert_eq!(status, "queued", "cancellation queues the final before draining the next human send");
                let token = crate::auth::issue_controller_token(&state.config, &space.owner_user_id)
                    .map_err(|e| controller_error("final cancel token", e))?.token;
                let final_id: Uuid = final_rows[0].get("id");
                post_checkpoint_request(crate::conversations::router().with_state(state.clone()), &format!("/jobs/{final_id}/cancel"), &token, json!({})).await?;
                let deadline = tokio::time::Instant::now()+std::time::Duration::from_secs(10);
                loop {
                    let row = pool.get().await?.query_one("select status,dispatched_run_id,error_message from conversation_send_queue where id=$1", &[&queued_send]).await?;
                    let status: String = row.get("status");
                    if row.get::<_, Option<Uuid>>("dispatched_run_id").is_some() {break;}
                    anyhow::ensure!(status != "failed", "queued send failed: {:?}", row.get::<_,Option<String>>("error_message"));
                    anyhow::ensure!(tokio::time::Instant::now()<deadline, "queued send did not drain after final: {status}");
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }
            Ok(())
        }.await;
        let cleanup = space.cleanup().await;
        result?;
        cleanup?;
    }
    Ok(())
}
