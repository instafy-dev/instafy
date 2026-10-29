use super::*;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, eventually, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tests_managed_ai_refund::{
    credit_balance, daily_prompts_used, ledger_rows, run_row, seed_reserved_managed_ai_prompt,
    ReservedManagedAiPrompt,
};
use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use std::collections::HashMap;
use tower::ServiceExt;

fn api_error(error: (StatusCode, Json<ApiError>)) -> anyhow::Error {
    anyhow::anyhow!("{}: {}", error.0, error.1 .0.message)
}

async fn post(
    app: Router,
    uri: &str,
    token: &str,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
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
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    Ok((status, serde_json::from_slice(&bytes)?))
}

async fn add_runtime(
    fixture: &ReservedManagedAiPrompt,
) -> anyhow::Result<(Uuid, Uuid, Uuid, String)> {
    let runtime = Uuid::new_v4();
    let lease = Uuid::new_v4();
    let generation = Uuid::new_v4();
    let mut capabilities = json!({ "agent": true, "origin": true });
    crate::runtime::set_runtime_generation_capability(&mut capabilities, generation);
    crate::runtime::set_self_hosted_access_attestation(
        capabilities.as_object_mut().unwrap(),
        fixture.owner_user_id,
    );
    let connection = fixture.pool.get().await?;
    connection
        .execute(
            "insert into runtimes (id,project_id,provider,status,last_seen_at,capabilities)
        values ($1,$2,'default','ready',now(),$3)",
            &[&runtime, &fixture.project_id, &PgJson(capabilities)],
        )
        .await?;
    connection
        .execute(
            "insert into runtime_leases (id,project_id,runtime_id,status,requested_at,launched_at)
        values ($1,$2,$3,'active',now(),now())",
            &[&lease, &fixture.project_id, &runtime],
        )
        .await?;
    connection
        .execute(
            "update runtimes set active_lease_id=$2 where id=$1",
            &[&runtime, &lease],
        )
        .await?;
    let token = crate::auth::issue_agent_token(
        &fixture.config,
        &fixture.project_id,
        &runtime,
        Some(&lease),
        Some(generation),
    )
    .map_err(api_error)?
    .token;
    Ok((runtime, lease, generation, token))
}

#[tokio::test]
async fn planning_receipts_persist_once_after_dispatch_or_refusal_with_lease_fencing(
) -> anyhow::Result<()> {
    for refused in [false, true] {
        let Some(fixture) = seed_reserved_managed_ai_prompt("planning-receipt").await? else {
            eprintln!("skipping planning receipt integration: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let result: anyhow::Result<()> = async {
            let (runtime, lease, generation, token) = add_runtime(&fixture).await?;
            let (_, _, _, wrong_token) = add_runtime(&fixture).await?;
            let connection = fixture.pool.get().await?;
            let conversation: Uuid = connection.query_one("update agent_jobs
                set status='leased',leased_by_runtime_id=$2,lease_attempts=2,leased_at=now(),lease_expires_at=now()+interval '1 minute'
                where id=$1 returning conversation_id", &[&fixture.job_id,&runtime]).await?.get(0);
            drop(connection);
            let outcome = if refused {
                ParentPlanOutcome::Refused { group_id: Uuid::new_v4(), reason: "No eligible worker runtime", code: "test_plan_refused" }
            } else { ParentPlanOutcome::Dispatched };
            finish_parent_plan_job(&fixture.state, fixture.project_id, conversation, None,
                fixture.job_id, Some(fixture.run_id), "Plan dispatched", outcome, None, Some(PlanningReceiptFence {
                    claims: crate::agent::TokenContext { project_id: fixture.project_id,
                        runtime_id: Some(runtime), lease_id: Some(lease), runtime_generation: Some(generation) },
                    lease_attempt: 2,
                })).await.map_err(api_error)?;
            let connection = fixture.pool.get().await?;
            let before = connection.query_one("select status,outcome,completed_at,planning_receipt_state from agent_jobs where id=$1", &[&fixture.job_id]).await?;
            assert_eq!(before.get::<_, JsonValue>("planning_receipt_state")["runtimeLeaseId"], json!(lease));
            let messages_before: i64 = connection.query_one("select count(*) from conversation_messages where conversation_id=$1", &[&conversation]).await?.get(0);
            let jobs_before: i64 = connection.query_one("select count(*) from agent_jobs where project_id=$1", &[&fixture.project_id]).await?.get(0);
            drop(connection);

            let receipt = crate::task_usage::tests::receipt_fixture();
            let mut artifacts = json!([receipt, {"kind":"codex/run-log","events":[{"type":"turn.completed",
                "usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":3000}}]}]);
            if refused { artifacts.as_array_mut().unwrap().push(json!({"kind":"diagnostic","text":"x".repeat(1024*1024)})); }
            let body = json!({"job_id":fixture.job_id,"outcome":"succeeded","summary":"Runtime must not replace controller result",
                "artifacts":artifacts,"proxy_metadata":{"provider":"codex-embedded"}});
            let app = crate::agent::router().with_state(fixture.state.clone());
            let wrong = post(app.clone(), "/agent/complete", &wrong_token, body.clone()).await?;
            assert_eq!(wrong.0, StatusCode::FORBIDDEN, "wrong runtime response: {:?}", wrong.1);
            let connection = fixture.pool.get().await?;
            connection.execute("update agent_jobs set lease_attempts=3 where id=$1", &[&fixture.job_id]).await?;
            assert_eq!(post(app.clone(), "/agent/complete", &token, body.clone()).await?.0, StatusCode::FORBIDDEN);
            connection.execute("update agent_jobs set lease_attempts=2 where id=$1", &[&fixture.job_id]).await?;
            // A fresh token for a later generation must not consume the old receipt slot.
            let replacement_lease = Uuid::new_v4();
            connection.execute("insert into runtime_leases (id,project_id,runtime_id,status) values ($1,$2,$3,'active')",
                &[&replacement_lease,&fixture.project_id,&runtime]).await?;
            connection.execute("update runtimes set active_lease_id=$2 where id=$1", &[&runtime,&replacement_lease]).await?;
            let replacement_token = crate::auth::issue_agent_token(&fixture.config,&fixture.project_id,&runtime,Some(&replacement_lease),Some(generation)).map_err(api_error)?.token;
            assert_eq!(post(app.clone(), "/agent/complete", &token, body.clone()).await?.0, StatusCode::UNAUTHORIZED);
            assert_eq!(post(app.clone(), "/agent/complete", &replacement_token, body.clone()).await?.0, StatusCode::FORBIDDEN);
            connection.execute("update runtimes set active_lease_id=$2 where id=$1", &[&runtime,&lease]).await?;
            drop(connection);

            let (first, duplicate) = tokio::join!(
                post(app.clone(), "/agent/complete", &token, body.clone()),
                post(app.clone(), "/agent/complete", &token, body.clone()),
            );
            assert_eq!(first?.0, StatusCode::OK);
            assert_eq!(duplicate?.0, StatusCode::OK);
            let ledger_after = ledger_rows(&fixture.pool,&fixture.project_id).await?;
            assert_eq!(ledger_after.iter().filter(|(_,_,key)| key.as_deref()==Some(format!("managed-ai-adjustment:{}",fixture.prompt_id).as_str())).count(),1);
            assert_eq!(post(app, "/agent/complete", &token, json!({"job_id":fixture.job_id,"outcome":"failed","artifacts":[]})).await?.0,StatusCode::OK);
            assert_eq!(ledger_rows(&fixture.pool,&fixture.project_id).await?,ledger_after);
            let connection = fixture.pool.get().await?;
            let after = connection.query_one("select status,outcome,completed_at,artifacts,planning_receipt_state from agent_jobs where id=$1", &[&fixture.job_id]).await?;
            for key in ["status","outcome"] { assert_eq!(after.get::<_,String>(key),before.get::<_,String>(key)); }
            assert_eq!(after.get::<_,Option<DateTime<Utc>>>("completed_at"), before.get::<_,Option<DateTime<Utc>>>("completed_at"));
            assert_eq!(after.get::<_,JsonValue>("planning_receipt_state")["state"],json!("received"));
            let stored: JsonValue = after.get("artifacts");
            if refused { assert_eq!(stored[0]["kind"],json!("instafy/artifacts-truncated")); } else { assert_eq!(stored,artifacts); }
            let metadata: JsonValue = connection.query_one("select metadata from runs where id=$1", &[&fixture.run_id]).await?.get(0);
            assert_eq!(metadata["aiTaskUsage"][fixture.job_id.to_string()]["calls"], receipt["calls"]);
            if refused { assert_eq!(metadata["errorMessage"], json!("No eligible worker runtime")); }
            assert_eq!(connection.query_one("select count(*) from conversation_messages where conversation_id=$1", &[&conversation]).await?.get::<_,i64>(0),messages_before);
            assert_eq!(connection.query_one("select count(*) from agent_jobs where project_id=$1", &[&fixture.project_id]).await?.get::<_,i64>(0),jobs_before);
            Ok(())
        }.await;
        let cleanup = fixture.cleanup().await;
        result?;
        cleanup?;
    }
    Ok(())
}

/// A hand-back is a turn Instafy starts by itself (crate::system_turns). A
/// team plan it writes that is refused ends it without a reply, so its
/// reserve and daily prompt slot come back at the refusal, and the runtime's
/// late receipt for it bills no tokens. A plan that goes out is its reply:
/// that receipt is billed as any turn's is.
#[tokio::test]
async fn a_hand_back_whose_team_plan_is_refused_costs_nothing() -> anyhow::Result<()> {
    for refused in [true, false] {
        let Some(fixture) = seed_reserved_managed_ai_prompt("system-turn-plan").await? else {
            eprintln!("skipping system turn plan integration: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let result: anyhow::Result<()> = async {
            let (runtime, lease, generation, token) = add_runtime(&fixture).await?;
            let connection = fixture.pool.get().await?;
            let conversation: Uuid = connection
                .query_one(
                    "update agent_jobs
                        set status = 'leased', leased_by_runtime_id = $2, lease_attempts = 1,
                            leased_at = now(), lease_expires_at = now() + interval '1 minute',
                            payload = jsonb_set(payload, '{metadata,browserHandBack}', $3::jsonb, true)
                      where id = $1
                  returning conversation_id",
                    &[
                        &fixture.job_id,
                        &runtime,
                        &PgJson(json!({ "version": 1, "browserJobId": Uuid::new_v4() })),
                    ],
                )
                .await?
                .get(0);
            drop(connection);
            let outcome = if refused {
                ParentPlanOutcome::Refused {
                    group_id: Uuid::new_v4(),
                    reason: "No eligible worker runtime",
                    code: "test_plan_refused",
                }
            } else {
                ParentPlanOutcome::Dispatched
            };
            finish_parent_plan_job(
                &fixture.state,
                fixture.project_id,
                conversation,
                None,
                fixture.job_id,
                Some(fixture.run_id),
                "Two scouts will read the pages the browser found.",
                outcome,
                None,
                Some(PlanningReceiptFence {
                    claims: crate::agent::TokenContext {
                        project_id: fixture.project_id,
                        runtime_id: Some(runtime),
                        lease_id: Some(lease),
                        runtime_generation: Some(generation),
                    },
                    lease_attempt: 1,
                }),
            )
            .await
            .map_err(api_error)?;

            let refunds = |rows: &[(String, i32, Option<String>)]| {
                rows.iter()
                    .filter(|(reason, _, _)| reason == "managed_ai_refund")
                    .map(|(_, delta, _)| *delta)
                    .collect::<Vec<_>>()
            };
            let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
            if refused {
                assert_eq!(refunds(&rows), vec![fixture.burn_amount], "{rows:?}");
                assert_eq!(
                    daily_prompts_used(&fixture.pool, &fixture.owner_user_id).await?,
                    0
                );
                let (_, run_metadata) = run_row(&fixture.pool, &fixture.run_id).await?;
                assert_eq!(
                    run_metadata["managedAiCredit"]["refund"]["refundReason"],
                    json!(crate::system_turns::SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON)
                );
            } else {
                assert!(refunds(&rows).is_empty(), "{rows:?}");
            }

            // The runtime's own completion of the planning turn arrives
            // later, with what the model used: 3,000 output tokens, two
            // credits against the one-credit reserve.
            let body = json!({
                "job_id": fixture.job_id,
                "outcome": "succeeded",
                "summary": "Runtime must not replace controller result",
                "artifacts": [{"kind": "codex/run-log", "events": [{"type": "turn.completed",
                    "usageScope": "turn",
                    "usage": {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 3000}}]}],
                "proxy_metadata": {"provider": "codex-embedded"},
            });
            let app = crate::agent::router().with_state(fixture.state.clone());
            assert_eq!(
                post(app, "/agent/complete", &token, body).await?.0,
                StatusCode::OK
            );
            let rows = ledger_rows(&fixture.pool, &fixture.project_id).await?;
            let adjustments = rows
                .iter()
                .filter(|(reason, _, _)| reason == "managed_ai_adjustment")
                .map(|(_, delta, _)| *delta)
                .collect::<Vec<_>>();
            let balance = credit_balance(&fixture.pool, &fixture.org_id).await?;
            if refused {
                assert!(adjustments.is_empty(), "no token is billed: {rows:?}");
                assert_eq!(balance, fixture.reserved_balance + fixture.burn_amount);
            } else {
                assert_eq!(adjustments, vec![-1], "{rows:?}");
                assert_eq!(balance, fixture.reserved_balance - 1);
            }
            Ok(())
        }
        .await;
        let cleanup = fixture.cleanup().await;
        result?;
        cleanup?;
    }
    Ok(())
}

#[tokio::test]
async fn cancel_plan_group_stops_queued_and_running_jobs_and_suppresses_late_checkpoints(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("cancel-plan-group").await? else {
        eprintln!("skipping plan group cancel integration: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let result: anyhow::Result<()> = async {
        let owner_token = crate::auth::issue_controller_token(&fixture.config,&fixture.owner_user_id).map_err(api_error)?.token;
        let stranger = Uuid::new_v4();
        let stranger_token = crate::auth::issue_controller_token(&fixture.config,&stranger).map_err(api_error)?.token;
        let app = crate::conversations::router().with_state(fixture.state.clone());
        let connection = fixture.pool.get().await?;
        let conversation: Uuid = connection.query_one("select conversation_id from agent_jobs where id=$1", &[&fixture.job_id]).await?.get(0);
        for all_terminal in [false,true] {
            let group = Uuid::new_v4();
            let mut jobs = Vec::new();
            let mut lanes = vec![("worker",if all_terminal {"completed"} else {"leased"}), ("worker",if all_terminal {"failed"} else {"queued"})];
            if !all_terminal { lanes.push(("lead_continuation", "leased")); }
            for (role,status) in lanes {
                let job = Uuid::new_v4();
                let payload = json!({"project_id":fixture.project_id,"conversation_id":conversation,"user_id":fixture.owner_user_id,
                    "metadata":{"multiAgentPlan":{"groupId":group,"role":role,"lead":{"leadHandle":"octo","continuationPrompt":"Summarize","expectedReportFormat":"brief"}}}});
                // Mix a legacy member with indexed rows, as an older plan can
                // still be running while the controller is upgraded.
                let indexed_group = if jobs.len() == 1 { None } else { Some(group) };
                connection.execute("insert into agent_jobs (id,project_id,conversation_id,status,payload,plan_group_id,agent_role)
                    values ($1,$2,$3,$4,$5,$6,$7)", &[&job,&fixture.project_id,&conversation,&status,&PgJson(payload),&indexed_group,&role]).await?;
                jobs.push(job);
            }
            let uri = format!("/jobs/plan-groups/{}/cancel", group.to_string().to_uppercase());
            assert_eq!(post(app.clone(),&uri,&stranger_token,json!({})).await?.0,StatusCode::FORBIDDEN);
            let (status, response) = post(app.clone(),&uri,&owner_token,json!({})).await?;
            assert_eq!(status,StatusCode::OK);
            assert_eq!(response["canceledJobIds"].as_array().unwrap().len(),if all_terminal {0} else {3});
            let notice_count: i64 = connection.query_one("select count(*) from conversation_messages where conversation_id=$1", &[&conversation]).await?.get(0);
            assert_eq!(post(app.clone(),&uri,&owner_token,json!({})).await?.0,StatusCode::OK);
            let worker_payload: JsonValue = connection.query_one("select payload from agent_jobs where id=$1", &[&jobs[0]]).await?.get(0);
            assert!(!maybe_enqueue_lead_continuation_after_completion(&fixture.state,jobs[0],&worker_payload).await.map_err(api_error)?);
            checkpoint_plan_groups_for_jobs(&fixture.state,&jobs).await.map_err(api_error)?;
            assert_eq!(connection.query_one("select count(*) from conversation_messages where conversation_id=$1", &[&conversation]).await?.get::<_,i64>(0),notice_count);
            assert_eq!(connection.query_one("select count(*) from agent_jobs where id=any($1)", &[&jobs]).await?.get::<_,i64>(0),if all_terminal {2} else {3});
            assert_eq!(connection.query_one("select count(*) from agent_jobs where id=any($1) and status in ('queued','leased')", &[&jobs]).await?.get::<_,i64>(0),0);
        }
        Ok(())
    }.await;
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}

#[tokio::test]
async fn invalid_plan_is_visible_without_dispatch_and_keeps_original_card_group_identity(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("invalid-team-plan").await? else {
        eprintln!("skipping invalid plan integration: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let result: anyhow::Result<()> = async {
        let (runtime, _, _, token) = add_runtime(&fixture).await?;
        let connection = fixture.pool.get().await?;
        connection.execute("insert into project_multi_agent_settings (project_id,max_agents_per_plan) values ($1,1)", &[&fixture.project_id]).await?;
        let conversation: Uuid = connection.query_one("update agent_jobs set status='leased',leased_by_runtime_id=$2,lease_attempts=1,lease_expires_at=now()+interval '1 minute'
            where id=$1 returning conversation_id", &[&fixture.job_id,&runtime]).await?.get(0);
        drop(connection);
        let plan = json!({"mode":"read_only","agents":[{"handle":"scout-a","prompt":"Read A"},{"handle":"scout-b","prompt":"Read B"}]});
        let body = json!({"job_id":fixture.job_id,"content":"Two scouts will inspect the files.","message_type":"multi_agent_plan","metadata":plan});
        let app = crate::agent::router().with_state(fixture.state.clone());
        assert_eq!(post(app.clone(),"/agent/message",&token,body.clone()).await?.0,StatusCode::OK);
        assert_eq!(post(app,"/agent/message",&token,body).await?.0,StatusCode::NOT_FOUND);
        let connection = fixture.pool.get().await?;
        let row = connection.query_one("select status,error_message from agent_jobs where id=$1", &[&fixture.job_id]).await?;
        assert_eq!(row.get::<_,String>("status"),"failed");
        assert!(row.get::<_,String>("error_message").contains("allows 1 per plan"));
        assert_eq!(connection.query_one("select count(*) from agent_jobs where conversation_id=$1", &[&conversation]).await?.get::<_,i64>(0),1);
        let cards = connection.query("select metadata from conversation_messages where conversation_id=$1 and metadata->>'messageType'='multi_agent_plan'", &[&conversation]).await?;
        assert_eq!(cards.len(),1,"group identity updates the existing message");
        let card: JsonValue = cards[0].get("metadata");
        assert_eq!(card["multiAgentPlan"]["agents"],plan["agents"]);
        assert_eq!(card["multiAgentPlan"]["status"],json!("refused"));
        assert!(card["multiAgentPlan"]["refusalReason"].as_str().unwrap().contains("allows 1 per plan"));
        let failure: JsonValue = connection.query_one("select metadata from conversation_messages where conversation_id=$1 and metadata->>'kind'='multi_agent_plan_invalid'", &[&conversation]).await?.get(0);
        assert!(failure["errorMessage"].as_str().unwrap().contains("No agents were dispatched"));
        assert_eq!(card["multiAgentPlan"]["groupId"],failure["multiAgentPlan"]["groupId"]);
        assert!(card["multiAgentPlan"]["groupId"].as_str().is_some());
        Ok(())
    }.await;
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}

#[tokio::test]
async fn refused_nested_worker_runs_its_normal_failure_checkpoint() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("refused-worker-checkpoint").await? else {
        eprintln!("skipping refused worker checkpoint integration: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let result: anyhow::Result<()> = async {
        let (runtime, _, _, token) = add_runtime(&fixture).await?;
        let group = Uuid::new_v4();
        let connection = fixture.pool.get().await?;
        let plan_metadata = json!({"runtimePreference":{"runtimeId":runtime},
            "multiAgentPlan":{"groupId":group,"role":"worker","lead":{"leadHandle":"octo"}}});
        let conversation: Uuid = connection.query_one("update agent_jobs
            set status='leased',leased_by_runtime_id=$2,lease_attempts=1,
                lease_expires_at=now()+interval '1 minute',plan_group_id=$3,agent_role='worker',
                payload=jsonb_set(payload,'{metadata}',coalesce(payload->'metadata','{}'::jsonb)||$4::jsonb)
            where id=$1 returning conversation_id",
            &[&fixture.job_id,&runtime,&group,&PgJson(plan_metadata)]).await?.get(0);
        drop(connection);
        let app = crate::agent::router().with_state(fixture.state.clone());
        let response = post(app.clone(),"/agent/message",&token,json!({"job_id":fixture.job_id,
            "content":"Attempting a nested plan.","message_type":"multi_agent_plan",
            "metadata":{"mode":"read_only","agents":[{"handle":"scout-a","prompt":"Read A"}]}})).await?;
        assert_eq!(response.0,StatusCode::OK,"{:?}",response.1);
        // The shared checkpoint runs immediately. Here it correctly refuses a
        // platform lead pinned to the private runtime, rather than waiting for
        // the periodic failed-worker sweep to discover this failed worker.
        let connection = fixture.pool.get().await?;
        let checkpoints = connection.query("select metadata from conversation_messages
            where conversation_id=$1 and metadata #>> '{multiAgentPlan,role}'='lead_continuation'",
            &[&conversation]).await?;
        assert_eq!(checkpoints.len(),1);
        let metadata: JsonValue = checkpoints[0].get(0);
        assert_eq!(metadata["kind"],json!(MANAGED_AI_HOSTED_RUNTIME_REQUIRED_CODE));
        assert_eq!(metadata["multiAgentPlan"]["groupId"],json!(group));
        assert_eq!(post(app,"/agent/complete",&token,json!({"job_id":fixture.job_id,"outcome":"succeeded","artifacts":[]})).await?.0,StatusCode::OK);
        assert_eq!(connection.query_one("select count(*) from conversation_messages
            where conversation_id=$1 and metadata #>> '{multiAgentPlan,role}'='lead_continuation'",
            &[&conversation]).await?.get::<_,i64>(0),1,"receipt does not run checkpoint twice");
        Ok(())
    }.await;
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}

#[tokio::test]
async fn planning_finalizer_keeps_the_issuing_generation_and_leaves_replacement_attempts_open(
) -> anyhow::Result<()> {
    for replacement_attempt in [false, true] {
        let Some(fixture) = seed_reserved_managed_ai_prompt("planning-fence-race").await? else {
            eprintln!("skipping planning fence race integration: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let result: anyhow::Result<()> = async {
            let (runtime, original_lease, original_generation, _) = add_runtime(&fixture).await?;
            let fence = PlanningReceiptFence {
                claims: crate::agent::TokenContext { project_id: fixture.project_id, runtime_id: Some(runtime),
                    lease_id: Some(original_lease), runtime_generation: Some(original_generation) },
                lease_attempt: 2,
            };
            let connection = fixture.pool.get().await?;
            let attempt = if replacement_attempt {3} else {2};
            let conversation: Uuid = connection.query_one("update agent_jobs
                set status='leased',leased_by_runtime_id=$2,lease_attempts=$3 where id=$1 returning conversation_id",
                &[&fixture.job_id,&runtime,&attempt]).await?.get(0);
            let message_count: i64 = connection.query_one("select count(*) from conversation_messages where conversation_id=$1",
                &[&conversation]).await?.get(0);
            let run_status: String = connection.query_one("select status from runs where id=$1", &[&fixture.run_id]).await?.get(0);
            // A runtime rotation between authenticated message acceptance and
            // finalization must never authorize the replacement generation.
            let next_lease = Uuid::new_v4();
            let next_generation = Uuid::new_v4();
            connection.execute("insert into runtime_leases (id,project_id,runtime_id,status) values ($1,$2,$3,'active')",
                &[&next_lease,&fixture.project_id,&runtime]).await?;
            connection.execute("update runtimes set active_lease_id=$2,
                capabilities=jsonb_set(capabilities,'{_instafyRuntimeTokenGeneration}',to_jsonb($3::text)) where id=$1",
                &[&runtime,&next_lease,&next_generation.to_string()]).await?;
            drop(connection);
            finish_parent_plan_job(&fixture.state,fixture.project_id,conversation,None,fixture.job_id,Some(fixture.run_id),
                "Old planning attempt",ParentPlanOutcome::Refused { group_id:Uuid::new_v4(),reason:"Refused",code:"test_refusal" },
                None,Some(fence)).await.map_err(api_error)?;
            let connection = fixture.pool.get().await?;
            let row = connection.query_one("select status,planning_receipt_state from agent_jobs where id=$1", &[&fixture.job_id]).await?;
            if replacement_attempt {
                assert_eq!(row.get::<_,String>("status"),"leased");
                assert!(row.get::<_,Option<JsonValue>>("planning_receipt_state").is_none());
                assert_eq!(connection.query_one("select status from runs where id=$1", &[&fixture.run_id]).await?.get::<_,String>(0),run_status);
                assert_eq!(connection.query_one("select count(*) from conversation_messages where conversation_id=$1", &[&conversation]).await?.get::<_,i64>(0),message_count);
            } else {
                let marker: JsonValue = row.get("planning_receipt_state");
                assert_eq!(marker["runtimeLeaseId"],json!(original_lease));
                assert_eq!(marker["runtimeGeneration"],json!(original_generation));
                let replacement_token = crate::auth::issue_agent_token(&fixture.config,&fixture.project_id,&runtime,
                    Some(&next_lease),Some(next_generation)).map_err(api_error)?.token;
                let response = post(crate::agent::router().with_state(fixture.state.clone()),"/agent/complete",&replacement_token,
                    json!({"job_id":fixture.job_id,"outcome":"succeeded","artifacts":[]})).await?;
                assert_eq!(response.0,StatusCode::FORBIDDEN,"{:?}",response.1);
            }
            Ok(())
        }.await;
        let cleanup = fixture.cleanup().await;
        result?;
        cleanup?;
    }
    Ok(())
}

#[tokio::test]
async fn a_helper_reply_folds_into_the_plan_without_a_reply_notification() -> anyhow::Result<()> {
    // The Studio folds a plan worker's own messages into the plan card, so its
    // completion must not reach the inbox, a lock screen, Home's feed or Home's
    // unread replies as a reply. The same completion outside a plan is an
    // ordinary visible reply.
    for worker in [true, false] {
        let Some(fixture) = seed_reserved_managed_ai_prompt("helper-reply-notification").await?
        else {
            eprintln!("skipping helper reply notification integration: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let result: anyhow::Result<()> = async {
            let (runtime, _, _, token) = add_runtime(&fixture).await?;
            let group = Uuid::new_v4();
            let connection = fixture.pool.get().await?;
            let plan_metadata = if worker {
                json!({"multiAgentPlan":{"groupId":group,"role":"worker","lead":{"leadHandle":"octo"}}})
            } else { json!({}) };
            let conversation: Uuid = connection.query_one("update agent_jobs
                set status='leased',leased_by_runtime_id=$2,lease_attempts=1,
                    lease_expires_at=now()+interval '1 minute',plan_group_id=$3,agent_role=$4,
                    payload=jsonb_set(payload,'{metadata}',coalesce(payload->'metadata','{}'::jsonb)||$5::jsonb)
                where id=$1 returning conversation_id",
                &[&fixture.job_id,&runtime,&worker.then_some(group),&worker.then_some("worker"),&PgJson(plan_metadata)]).await?.get(0);
            drop(connection);
            let app = crate::agent::router().with_state(fixture.state.clone());
            let response = post(app,"/agent/complete",&token,json!({"job_id":fixture.job_id,"outcome":"succeeded",
                "summary":"Read the three files; the blue version keeps its contrast.","artifacts":[]})).await?;
            assert_eq!(response.0,StatusCode::OK,"{:?}",response.1);
            let connection = fixture.pool.get().await?;
            let reply = connection.query_one("select id,metadata from conversation_messages
                where conversation_id=$1 and role='assistant' and metadata->>'jobId'=$2",
                &[&conversation,&fixture.job_id.to_string()]).await?;
            let (reply_id, metadata): (Uuid, JsonValue) = (reply.get(0), reply.get(1));
            assert_eq!(metadata["multiAgentPlan"]["role"]==json!("worker"),worker,"{metadata}");
            let replies: i64 = connection.query_one("select count(*) from notification_events where producer_key=$1",
                &[&format!("conversation.reply:{reply_id}")]).await?.get(0);
            assert_eq!(replies,if worker {0} else {1},"worker={worker}");
            let feed: i64 = connection.query_one("select count(*) from activity_events
                where kind='conversation.reply' and conversation_id=$1 and run_id=$2",
                &[&conversation,&fixture.run_id]).await?.get(0);
            assert_eq!(feed,if worker {0} else {1},"worker={worker}");
            drop(connection);
            let owner_token = crate::auth::issue_controller_token(&fixture.config,&fixture.owner_user_id).map_err(api_error)?.token;
            let response = crate::notifications::router().with_state(fixture.state.clone()).oneshot(Request::builder()
                .method("GET").uri("/me/notifications/inbox")
                .header("authorization",format!("Bearer {owner_token}")).body(Body::empty())?).await?;
            assert_eq!(response.status(),StatusCode::OK);
            let inbox: JsonValue = serde_json::from_slice(&to_bytes(response.into_body(),usize::MAX).await?)?;
            let unread = inbox["items"].as_array().ok_or_else(|| anyhow::anyhow!("inbox items: {inbox}"))?.iter()
                .any(|item| item["conversationId"]==json!(conversation) && item["lastMessageId"]==json!(reply_id));
            assert_eq!(unread,!worker,"worker={worker}: {inbox}");
            Ok(())
        }.await;
        let cleanup = fixture.cleanup().await;
        result?;
        cleanup?;
    }
    Ok(())
}

// Faces (docs/Brand.md, "Octo's hatchlings"). Dispatch gives each AI without a
// profile its face of the chat (`dispatch::agent_faces`), and a lane's reruns
// keep the face the lane wears.

/// A face test's chat: a space whose owner pays with a key of their own, so no
/// Instafy AI gate stands between a send and its dispatch, with a root
/// conversation and a thread of it.
struct FaceChat {
    state: AppState,
    owner: Uuid,
    org: Uuid,
    project: Uuid,
    root: Uuid,
    thread: Uuid,
}

/// One job of an AI in the chat, with the AI it carries (`metadata.agent`).
#[derive(Debug, Clone)]
struct AiJob {
    id: Uuid,
    run: Option<Uuid>,
    conversation: Uuid,
    handle: String,
    seed: Option<String>,
    agent_id: Option<String>,
    payload: JsonValue,
}

const AI_JOB_COLUMNS: &str = "id, run_id, conversation_id, payload";

impl AiJob {
    fn of(row: &tokio_postgres::Row) -> Self {
        let payload = row.get::<_, PgJson<JsonValue>>("payload").0;
        let agent = |key: &str| {
            payload
                .pointer(&format!("/metadata/agent/{key}"))
                .and_then(JsonValue::as_str)
                .map(str::to_string)
        };
        let (handle, seed, agent_id) = (agent("handle"), agent("avatarSeed"), agent("id"));
        Self {
            id: row.get("id"),
            run: row.get("run_id"),
            conversation: row
                .get::<_, Option<Uuid>>("conversation_id")
                .unwrap_or_default(),
            handle: handle.unwrap_or_default(),
            seed,
            agent_id,
            payload,
        }
    }
}

/// Octo as its planning job carries it.
fn octo() -> JsonValue {
    json!({"handle": "octo", "displayName": "Octo", "avatarSeed": "octo"})
}

fn stamps(faces: impl IntoIterator<Item = u8>) -> Vec<String> {
    faces
        .into_iter()
        .map(|face| format!("hatchling:{face}"))
        .collect()
}

fn legacy_face(seed: &str) -> u8 {
    runtime_contracts::agent_face::legacy_hatchling(seed)
        .expect("a seed to hash")
        .number()
}

/// A saved agent's id whose legacy face is none of `faces`.
fn id_wearing_none_of(faces: &[u8]) -> Uuid {
    loop {
        let id = Uuid::new_v4();
        if !faces.contains(&legacy_face(&id.to_string())) {
            return id;
        }
    }
}

/// What a turn continuation of `job` records in its plan metadata.
fn continuation_of(job: &AiJob) -> Vec<(&'static str, JsonValue)> {
    let turn = turn_continuation::continuation_turn(&job.payload) + 1;
    vec![(
        "continuation",
        json!({"of": job.id, "turn": turn, "last": false, "endedBy": "time_limit"}),
    )]
}

/// What a rate-limit retry of `job` records: the retry, and the turn it runs again.
fn rate_limit_retry_of(job: &AiJob) -> Vec<(&'static str, JsonValue)> {
    let mut meta = vec![(
        "rateLimitRetry",
        json!({"of": job.id, "waitMs": 3000, "holdMs": 3000, "reason": "upstream_rate_limit"}),
    )];
    if let Some(continuation) = job
        .payload
        .pointer("/metadata/multiAgentPlan/continuation")
        .filter(|value| value.is_object())
    {
        meta.push(("continuation", continuation.clone()));
    }
    meta
}

/// `future`, which must not wait on the chat's face lock: it fails instead of
/// hanging if it does.
async fn within<T>(
    future: impl std::future::Future<Output = anyhow::Result<T>>,
) -> anyhow::Result<T> {
    tokio::time::timeout(std::time::Duration::from_secs(20), future)
        .await
        .map_err(|_| anyhow::anyhow!("still waiting after 20 s"))?
}

async fn get(app: Router, uri: &str, token: &str) -> anyhow::Result<(StatusCode, JsonValue)> {
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    Ok((status, serde_json::from_slice(&bytes)?))
}

/// A session of its own holding a root conversation's face lock, as a
/// dispatch that gives an AI a face does, until it is released. A dispatch
/// that waits for the lock waits behind the session's backend, `pid`.
struct FaceLock {
    client: tokio_postgres::Client,
    pid: i32,
}

impl FaceLock {
    async fn hold(root: Uuid) -> anyhow::Result<Self> {
        let url = std::env::var("TEST_DATABASE_URL")?;
        let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await?;
        tokio::spawn(connection);
        let pid = client
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        client
            .execute(
                "select pg_advisory_lock(hashtextextended($1, 0))",
                &[&format!("conversation-faces:{root}")],
            )
            .await?;
        Ok(Self { client, pid })
    }

    async fn release(self) -> anyhow::Result<()> {
        self.client
            .batch_execute("select pg_advisory_unlock_all()")
            .await?;
        Ok(())
    }
}

impl FaceChat {
    async fn new(test: &str) -> anyhow::Result<Self> {
        let pool = require_origin_test_pool(test).await?;
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "agent-faces",
        );
        Ok(Self {
            state: build_test_state(pool, config),
            owner: Uuid::new_v4(),
            org: Uuid::new_v4(),
            project: Uuid::new_v4(),
            root: Uuid::new_v4(),
            thread: Uuid::new_v4(),
        })
    }

    /// Runs `body` on the chat's rows, then deletes them however it ends.
    async fn run(
        &self,
        body: impl std::future::Future<Output = anyhow::Result<()>>,
    ) -> anyhow::Result<()> {
        use futures_util::FutureExt;
        let fixture = SharedDbFixture {
            organizations: vec![self.org],
            projects: vec![self.project],
        };
        let outcome = std::panic::AssertUnwindSafe(with_shared_db_fixture(fixture, async {
            self.seed().await?;
            body.await
        }))
        .catch_unwind()
        .await;
        self.state
            .pool
            .get()
            .await?
            .execute("delete from auth.users where id = $1", &[&self.owner])
            .await?;
        match outcome {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    async fn seed(&self) -> anyhow::Result<()> {
        ensure_test_user(&self.state.pool, &self.owner).await?;
        let db = self.state.pool.get().await?;
        db.execute(
            "insert into organizations (id, slug, name) values ($1, $2, 'Faces')",
            &[&self.org, &format!("faces-{}", self.org)],
        )
        .await?;
        db.execute(
            "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
            &[&self.org, &self.owner],
        )
        .await?;
        db.execute(
            "insert into projects (id, org_id, owner_user_id, project_type, status)
             values ($1, $2, $3, 'customer', 'active')",
            &[&self.project, &self.org, &self.owner],
        )
        .await?;
        db.execute(
            "insert into conversations (id, project_id, created_by, metadata, visibility, root_conversation_id)
             values ($1, $2, $3, '{}', 'private', $1)",
            &[&self.root, &self.project, &self.owner],
        )
        .await?;
        db.execute(
            "insert into conversations (
                 id, project_id, created_by, metadata, visibility,
                 parent_conversation_id, root_conversation_id, thread_kind
             ) values ($1, $2, $3, '{}', 'private', $4, $4, 'thread')",
            &[&self.thread, &self.project, &self.owner, &self.root],
        )
        .await?;
        db.execute(
            "insert into user_credentials (
                 id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
             ) values ($1, $2, 'openai_api_key', 'Own', 'fixture', 'fixture', '{}', true)",
            &[&Uuid::new_v4(), &self.owner],
        )
        .await?;
        Ok(())
    }

    fn member(&self) -> RequestContext {
        RequestContext {
            user_id: Some(self.owner),
            is_service_role: false,
            scoped_claims: None,
        }
    }

    fn owner_token(&self) -> anyhow::Result<String> {
        Ok(
            crate::auth::issue_controller_token(&self.state.config, &self.owner)
                .map_err(api_error)?
                .token,
        )
    }

    /// The owner's saved agent `handle`, wearing `seed`.
    async fn save_agent(&self, id: Uuid, handle: &str, seed: &str) -> anyhow::Result<()> {
        self.state
            .pool
            .get()
            .await?
            .execute(
                "insert into user_agents (id, user_id, provider, handle, display_name, avatar_seed)
                 values ($1, $2, 'openai', $3, $3, $4)",
                &[&id, &self.owner, &handle, &seed],
            )
            .await?;
        Ok(())
    }

    /// The owner's message to `@handle` in `conversation`, dispatched as Studio
    /// sends it. Returns its job.
    async fn send(&self, conversation: Uuid, handle: &str) -> anyhow::Result<AiJob> {
        self.send_as(&self.member(), conversation, handle, json!({}))
            .await
    }

    async fn send_as(
        &self,
        context: &RequestContext,
        conversation: Uuid,
        handle: &str,
        mut metadata: JsonValue,
    ) -> anyhow::Result<AiJob> {
        metadata["clientMessageId"] = json!(Uuid::new_v4());
        metadata["agentSelection"] = json!({"active": [handle], "mentions": [handle]});
        let request: DispatchPromptRequest = serde_json::from_value(json!({
            "projectId": self.project,
            "conversationId": conversation,
            "promptText": format!("@{handle} check what changed in the release notes"),
            "intent": "feature",
            "metadata": metadata,
        }))?;
        let request = normalize_dispatch_request(request).map_err(api_error)?;
        let response = process_dispatch_prompt(&self.state, context, request)
            .await
            .map_err(api_error)?;
        let job = response.job_id.ok_or_else(|| {
            anyhow::anyhow!("the send to @{handle} queued no job: {}", response.status)
        })?;
        self.job(job).await
    }

    /// `lead` plans `lanes` in `conversation`, and the controller dispatches the
    /// plan as it does once the planning turn posts its card. Returns the
    /// planning job.
    async fn plan(
        &self,
        conversation: Uuid,
        lead: JsonValue,
        lanes: &[&str],
    ) -> anyhow::Result<Uuid> {
        let job = Uuid::new_v4();
        let run = Uuid::new_v4();
        let payload = json!({
            "project_id": self.project,
            "conversation_id": conversation,
            "user_id": self.owner,
            "prompt_text": "Split the reading between a few helpers.",
            "metadata": {"agent": lead},
        });
        let db = self.state.pool.get().await?;
        db.execute(
            "insert into runs (id, project_id, conversation_id, run_type, status)
             values ($1, $2, $3, 'prompt', 'in_progress')",
            &[&run, &self.project, &conversation],
        )
        .await?;
        db.execute(
            "insert into agent_jobs (id, project_id, run_id, conversation_id, status, intent, payload)
             values ($1, $2, $3, $4, 'leased', 'feature', $5)",
            &[&job, &self.project, &run, &conversation, &PgJson(&payload)],
        )
        .await?;
        drop(db);
        let planning = self.job(job).await?;
        self.execute_plan(&planning, lanes).await?;
        Ok(job)
    }

    /// The turn `planning` posts a plan of `lanes`, and the controller
    /// dispatches it.
    async fn execute_plan(&self, planning: &AiJob, lanes: &[&str]) -> anyhow::Result<()> {
        let agents: Vec<JsonValue> = lanes
            .iter()
            .map(|handle| json!({"handle": handle, "prompt": format!("Read what {handle} owns.")}))
            .collect();
        let message = json!({"messageType": "multi_agent_plan", "details": {
            "mode": "read_only",
            "agents": agents,
            "lead": {"leadHandle": planning.handle, "continuationPrompt": "Report what each helper found."},
        }});
        // Heap-owned, as dispatch is: a test joins two of these.
        let handled = Box::pin(maybe_execute_multi_agent_plan_message(
            &self.state,
            &planning.payload,
            planning.id,
            planning.run,
            &message,
            "A few helpers will split the reading.",
            None,
            None,
        ))
        .await
        .map_err(api_error)?;
        assert!(handled, "the plan message was handled");
        let row = self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select status, error_message from agent_jobs where id = $1",
                &[&planning.id],
            )
            .await?;
        assert_eq!(
            row.get::<_, String>("status"),
            "completed",
            "the plan was not dispatched: {:?}",
            row.get::<_, Option<String>>("error_message")
        );
        Ok(())
    }

    async fn job(&self, id: Uuid) -> anyhow::Result<AiJob> {
        let row = self
            .state
            .pool
            .get()
            .await?
            .query_one(
                &format!("select {AI_JOB_COLUMNS} from agent_jobs where id = $1"),
                &[&id],
            )
            .await?;
        Ok(AiJob::of(&row))
    }

    /// The first run of each lane of the plan `planning_job` dispatched.
    async fn lanes(&self, planning_job: Uuid) -> anyhow::Result<Vec<AiJob>> {
        let rows = self
            .state
            .pool
            .get()
            .await?
            .query(
                &format!(
                    "select {AI_JOB_COLUMNS} from agent_jobs
                     where project_id = $1 and parent_job_id = $2
                       and payload #> '{{metadata,multiAgentPlan,continuation,of}}' is null
                       and payload #> '{{metadata,multiAgentPlan,rateLimitRetry}}' is null
                       and payload #> '{{metadata,multiAgentPlan,userInputContinuation}}' is null"
                ),
                &[&self.project, &planning_job],
            )
            .await?;
        Ok(rows.iter().map(AiJob::of).collect())
    }

    async fn lane(&self, planning_job: Uuid, handle: &str) -> anyhow::Result<AiJob> {
        let lanes = self.lanes(planning_job).await?;
        lanes
            .iter()
            .find(|lane| lane.handle == handle)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("no lane {handle} in {lanes:?}"))
    }

    /// The face each of `handles` wears in the first run of its lane of the
    /// plan `planning_job` dispatched.
    async fn faces(&self, planning_job: Uuid, handles: &[&str]) -> anyhow::Result<Vec<String>> {
        let lanes = self.lanes(planning_job).await?;
        handles
            .iter()
            .map(|handle| {
                lanes
                    .iter()
                    .find(|lane| lane.handle == *handle)
                    .and_then(|lane| lane.seed.clone())
                    .ok_or_else(|| anyhow::anyhow!("no face for lane {handle} in {lanes:?}"))
            })
            .collect()
    }

    /// The jobs end, as their runtime completes them.
    async fn end(&self, jobs: &[Uuid]) -> anyhow::Result<()> {
        self.state
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs
                 set status = 'completed', outcome = 'succeeded', lease_expires_at = null,
                     completed_at = now(), updated_at = now()
                 where id = any($1)",
                &[&jobs.to_vec()],
            )
            .await?;
        Ok(())
    }

    /// `job` ended `minutes` ago.
    async fn ended_ago(&self, job: Uuid, minutes: i32) -> anyhow::Result<()> {
        self.state
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs set completed_at = now() - make_interval(mins => $2)
                 where id = $1",
                &[&job, &minutes],
            )
            .await?;
        Ok(())
    }

    /// The lane of `job` asks its person a question, which stays `status`.
    async fn ask(&self, job: &AiJob, status: &str) -> anyhow::Result<()> {
        let group = job
            .payload
            .pointer("/metadata/multiAgentPlan/groupId")
            .and_then(JsonValue::as_str)
            .map(Uuid::parse_str)
            .ok_or_else(|| anyhow::anyhow!("{} names no plan group", job.id))??;
        self.state
            .pool
            .get()
            .await?
            .execute(
                "insert into agent_user_input_requests (
                     project_id, conversation_id, job_id, lease_attempt, group_id, agent_handle,
                     questions, continuation_note, status
                 ) values ($1, $2, $3, 0, $4, $5, '[]', 'Go on with the answer.', $6)
                 on conflict (job_id) do update set status = excluded.status",
                &[
                    &self.project,
                    &job.conversation,
                    &job.id,
                    &group,
                    &job.handle,
                    &status,
                ],
            )
            .await?;
        Ok(())
    }

    /// `count` turns of Octo in `conversation`, newer than every job before them.
    async fn octo_turns(&self, conversation: Uuid, count: i32) -> anyhow::Result<()> {
        self.state
            .pool
            .get()
            .await?
            .execute(
                "insert into agent_jobs (project_id, conversation_id, status, intent, payload, completed_at)
                 select $1, $2, 'completed', 'feature', $3, now() from generate_series(1, $4)",
                &[
                    &self.project,
                    &conversation,
                    &PgJson(json!({"metadata": {"agent": octo()}})),
                    &count,
                ],
            )
            .await?;
        Ok(())
    }

    /// Every job of the plan `planning_job` dispatched ends.
    async fn end_plan(&self, planning_job: Uuid) -> anyhow::Result<()> {
        let jobs: Vec<Uuid> = self
            .lanes(planning_job)
            .await?
            .iter()
            .map(|lane| lane.id)
            .collect();
        self.end(&jobs).await
    }

    /// The controller starts the agent of `ended` again once `ended` is over:
    /// `plan_meta` says whether the new job continues its turn, retries it after
    /// a rate limit or resumes it with an answer. Returns the new job.
    async fn rerun(
        &self,
        ended: &AiJob,
        plan_meta: Vec<(&'static str, JsonValue)>,
    ) -> anyhow::Result<AiJob> {
        let plan = ended
            .payload
            .pointer("/metadata/multiAgentPlan")
            .and_then(JsonValue::as_object)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("{} is no plan job", ended.id))?;
        let group = plan
            .get("groupId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| anyhow::anyhow!("{} names no plan group", ended.id))?
            .to_string();
        let agent = turn_continuation::plan_job_agent(&ended.payload)
            .ok_or_else(|| anyhow::anyhow!("lane {} is not in its plan seed", ended.handle))?;
        let redispatch = turn_continuation::PlanAgentRedispatch {
            prompt: agent.prompt.clone(),
            agent,
            rationale: "Started again by the controller",
            reason: "The controller started the agent again.",
            runtime_id: None,
            plan_meta,
        };
        let job = Box::pin(turn_continuation::redispatch_plan_agent(
            &self.state,
            self.project,
            ended.conversation,
            &group,
            ended.id,
            &ended.payload,
            &plan,
            redispatch,
        ))
        .await
        .map_err(api_error)?
        .ok_or_else(|| anyhow::anyhow!("the rerun of {} queued no job", ended.handle))?;
        self.job(job).await
    }

    /// Leases `job` to a runtime of the space, and mints the job token its turn
    /// runs with.
    async fn job_token(&self, job: &AiJob) -> anyhow::Result<String> {
        let runtime = Uuid::new_v4();
        let lease = Uuid::new_v4();
        let db = self.state.pool.get().await?;
        db.execute(
            "insert into runtimes (id, project_id, provider, status) values ($1, $2, 'default', 'running')",
            &[&runtime, &self.project],
        )
        .await?;
        db.execute(
            "insert into runtime_leases (id, project_id, runtime_id, status, launched_at)
             values ($1, $2, $3, 'active', now())",
            &[&lease, &self.project, &runtime],
        )
        .await?;
        db.execute(
            "update runtimes set active_lease_id = $2 where id = $1",
            &[&runtime, &lease],
        )
        .await?;
        db.execute(
            "update agent_jobs
             set status = 'leased', leased_by_runtime_id = $2, leased_at = now(), lease_attempts = 1,
                 lease_expires_at = now() + interval '5 minutes'
             where id = $1",
            &[&job.id, &runtime],
        )
        .await?;
        let token = crate::tokens::mint_scoped_token(
            &self.state.config,
            crate::tokens::ScopedTokenRequest {
                audience: runtime.to_string(),
                subject: self.owner.to_string(),
                project_id: self.project.to_string(),
                origin_id: None,
                runtime_id: Some(runtime.to_string()),
                protocol: None,
                scopes: vec![
                    "prompt.execute".to_string(),
                    crate::origins::JOB_TOKEN_SEPARATED_SCOPE.to_string(),
                ],
                lease_id: Some(lease.to_string()),
                run_id: job.run.map(|run| run.to_string()),
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        )
        .map_err(api_error)?;
        Ok(token.token)
    }

    /// The metadata of the person's message that dispatched `job`.
    async fn sent_message(&self, job: &AiJob) -> anyhow::Result<JsonValue> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select metadata from conversation_messages where run_id = $1 and role = 'user'",
                &[&job.run],
            )
            .await?
            .get(0))
    }

    /// Who the runtime alerts posted for `runs` speak as.
    async fn alerts(&self, runs: &[Option<Uuid>]) -> anyhow::Result<Vec<JsonValue>> {
        let runs: Vec<Uuid> = runs.iter().flatten().copied().collect();
        let rows = self
            .state
            .pool
            .get()
            .await?
            .query(
                "select metadata -> 'agent' from conversation_messages
                 where project_id = $1 and run_id = any($2) and metadata ->> 'kind' = 'runtime_alert'",
                &[&self.project, &runs],
            )
            .await?;
        Ok(rows.iter().map(|row| row.get(0)).collect())
    }

    /// Fails the statement of the session waiting for `lock`, once it waits.
    async fn cancel_wait_for(&self, lock: &FaceLock) -> anyhow::Result<()> {
        let waiting = self.waiting_behind(lock.pid).await?;
        let canceled: bool = self
            .state
            .pool
            .get()
            .await?
            .query_one("select pg_cancel_backend($1)", &[&waiting])
            .await?
            .get(0);
        anyhow::ensure!(canceled, "session {waiting} was not signalled");
        Ok(())
    }

    /// The session waiting behind the session `blocker` for a lock (one that
    /// `blocker` holds, or waits for ahead of it), once one waits. Only this
    /// test's sessions wait behind its own, so a shared database's other
    /// sessions are never found.
    async fn waiting_behind(&self, blocker: i32) -> anyhow::Result<i32> {
        let pool = &self.state.pool;
        eventually("a session waiting behind another", || async move {
            Ok(pool
                .get()
                .await?
                .query_opt(
                    "select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
                    &[&blocker],
                )
                .await?
                .map(|row| row.get(0)))
        })
        .await
    }
}

#[tokio::test]
async fn a_plans_lanes_wear_their_own_faces_through_every_rerun() -> anyhow::Result<()> {
    let chat = FaceChat::new("a plan's lanes and their faces").await?;
    chat.run(async {
        let mut events = chat.state.events.subscribe();
        let plan = chat
            .plan(chat.root, octo(), &["tokyo", "kyoto", "nara"])
            .await?;
        // Octo leads and wears no hatchling: a new chat's lanes take the first three.
        assert_eq!(
            chat.faces(plan, &["tokyo", "kyoto", "nara"]).await?,
            stamps([1, 2, 3])
        );
        let lanes = chat.lanes(plan).await?;
        let mut queued = HashMap::new();
        while let Ok(event) = events.try_recv() {
            if event.kind == "run.queued" {
                queued.insert(
                    event.run_id,
                    event.data["run"]["metadata"]["agent"]["avatarSeed"].clone(),
                );
            }
        }
        let db = chat.state.pool.get().await?;
        for lane in &lanes {
            let run: JsonValue = db
                .query_one("select metadata from runs where id = $1", &[&lane.run])
                .await?
                .get(0);
            assert_eq!(run["agent"]["avatarSeed"], json!(lane.seed), "{run}");
            assert_eq!(queued.get(&lane.run), Some(&json!(lane.seed)), "{queued:?}");
        }
        drop(db);

        // The plan card's legend reads each lane's face from the group's status.
        let group = lanes[0].payload["metadata"]["multiAgentPlan"]["groupId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let app = crate::agent::router().with_state(chat.state.clone());
        let (status, group_status) = get(
            app,
            &format!("/agent/plan-groups/{group}/status"),
            &chat.owner_token()?,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{group_status}");
        let legend: HashMap<&str, &str> = group_status["workers"]
            .as_array()
            .map(|workers| {
                workers
                    .iter()
                    .filter_map(|worker| {
                        Some((worker["handle"].as_str()?, worker["avatarSeed"].as_str()?))
                    })
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(
            legend,
            HashMap::from([
                ("tokyo", "hatchling:1"),
                ("kyoto", "hatchling:2"),
                ("nara", "hatchling:3")
            ])
        );

        // Kyoto's reruns are one-lane plans that put it first, and keep its face. They
        // give no AI a face, so they run while another dispatch holds the chat's face lock.
        let kyoto = chat.lane(plan, "kyoto").await?;
        chat.end(&[kyoto.id]).await?;
        let kyoto = chat.job(kyoto.id).await?;
        let lock = FaceLock::hold(chat.root).await?;
        let continued = within(chat.rerun(&kyoto, continuation_of(&kyoto))).await?;
        chat.end(&[continued.id]).await?;
        let continued = chat.job(continued.id).await?;
        let retried = within(chat.rerun(&continued, rate_limit_retry_of(&continued))).await?;
        lock.release().await?;
        let db = chat.state.pool.get().await?;
        for rerun in [&continued, &retried] {
            assert_eq!(rerun.handle, "kyoto");
            assert_eq!(rerun.seed.as_deref(), Some("hatchling:2"), "{rerun:?}");
            let run: JsonValue = db
                .query_one("select metadata from runs where id = $1", &[&rerun.run])
                .await?
                .get(0);
            assert_eq!(run["agent"]["avatarSeed"], "hatchling:2", "{run}");
        }
        assert_eq!(
            retried.payload["metadata"]["multiAgentPlan"]["rateLimitRetry"]["of"],
            json!(continued.id)
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn each_new_plan_takes_the_free_faces_least_recently_used_first() -> anyhow::Result<()> {
    let chat = FaceChat::new("faces across a chat's plans").await?;
    chat.run(async {
        // Two plans at work at once wear four different faces.
        let first = chat.plan(chat.root, octo(), &["ash", "birch"]).await?;
        let second = chat.plan(chat.root, octo(), &["cedar", "elm"]).await?;
        assert_eq!(chat.faces(first, &["ash", "birch"]).await?, stamps([1, 2]));
        assert_eq!(chat.faces(second, &["cedar", "elm"]).await?, stamps([3, 4]));
        // Once they end, faces nobody wore come first...
        chat.end_plan(first).await?;
        chat.end_plan(second).await?;
        let third = chat.plan(chat.root, octo(), &["fir", "hazel"]).await?;
        assert_eq!(chat.faces(third, &["fir", "hazel"]).await?, stamps([5, 6]));
        chat.end_plan(third).await?;
        let fourth = chat.plan(chat.root, octo(), &["juniper", "larch"]).await?;
        assert_eq!(
            chat.faces(fourth, &["juniper", "larch"]).await?,
            stamps([7, 8])
        );
        chat.end_plan(fourth).await?;
        // ...then the faces worn longest ago: the first plan's, then the second's.
        let fifth = chat
            .plan(chat.root, octo(), &["maple", "oak", "pine"])
            .await?;
        assert_eq!(
            chat.faces(fifth, &["maple", "oak", "pine"]).await?,
            stamps([1, 2, 3])
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn dispatches_in_a_chat_and_its_thread_at_once_wear_different_faces() -> anyhow::Result<()> {
    let chat = FaceChat::new("faces in a chat and its thread at once").await?;
    chat.run(async {
        let (in_chat, in_thread) = tokio::join!(
            chat.plan(chat.root, octo(), &["north", "south"]),
            chat.plan(chat.thread, octo(), &["east", "west"]),
        );
        let mut faces = chat.faces(in_chat?, &["north", "south"]).await?;
        faces.extend(chat.faces(in_thread?, &["east", "west"]).await?);
        faces.sort();
        assert_eq!(faces, stamps([1, 2, 3, 4]));

        // A send in the thread that gives an AI a face takes the chat's row before
        // the chat's face lock, so a send in the chat waits for that row, never for
        // the faces while holding it: the thread's send, once it has the faces,
        // bumps the chat's row as it records its message, and the two would wait
        // on each other.
        let lock = FaceLock::hold(chat.root).await?;
        let (in_thread, in_chat) = tokio::join!(chat.send(chat.thread, "sam"), async {
            let thread_send = chat.waiting_behind(lock.pid).await?;
            let (sent, released) = tokio::join!(chat.send(chat.root, "ben"), async {
                chat.waiting_behind(thread_send).await?;
                lock.release().await
            });
            released?;
            sent
        });
        assert_eq!(in_thread?.seed.as_deref(), Some("hatchling:5"));
        assert_eq!(in_chat?.seed.as_deref(), Some("hatchling:6"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn only_a_dispatch_that_gives_a_face_takes_the_chats_face_lock() -> anyhow::Result<()> {
    let chat = FaceChat::new("the chat's face lock").await?;
    chat.run(async {
        let plan = chat.plan(chat.root, octo(), &["scout"]).await?;
        let scout = chat.lane(plan, "scout").await?;
        chat.end(&[scout.id]).await?;
        let scout = chat.job(scout.id).await?;
        let lock = FaceLock::hold(chat.root).await?;
        // Octo, and a rerun that keeps its lane's face, give no AI a face.
        let octo = within(chat.send(chat.root, "octo")).await?;
        assert_eq!(octo.seed.as_deref(), Some("octo"));
        let continued = within(chat.rerun(&scout, continuation_of(&scout))).await?;
        assert_eq!(continued.seed.as_deref(), Some("hatchling:1"));
        // An AI without a profile waits for the lock, then takes a face of its own.
        let (ben, released) = tokio::join!(chat.send(chat.root, "ben"), async {
            chat.waiting_behind(lock.pid).await?;
            lock.release().await
        });
        released?;
        assert_eq!(ben?.seed.as_deref(), Some("hatchling:2"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn helpers_keep_off_the_faces_of_saved_agents_that_ran_in_the_chat() -> anyhow::Result<()> {
    let chat = FaceChat::new("saved agents' faces in a chat").await?;
    chat.run(async {
        // Pia's owner picked face 1, Sol is older and wears the face of its id,
        // and Max has a picture.
        let sol = id_wearing_none_of(&[1]);
        let sol_face = legacy_face(&sol.to_string());
        let max = id_wearing_none_of(&[1, sol_face]);
        chat.save_agent(Uuid::new_v4(), "pia", "hatchling:1")
            .await?;
        chat.save_agent(sol, "sol", &sol.to_string()).await?;
        chat.save_agent(max, "max", "https://cdn.example.com/max.png")
            .await?;
        let mut ran = Vec::new();
        for handle in ["pia", "sol", "max"] {
            ran.push(chat.send(chat.root, handle).await?.id);
        }
        chat.end(&ran).await?;
        // Eight helpers share the six faces left, in order: Max's picture covers no
        // face of the eight, not even the one drawn behind it.
        let lanes = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"];
        let plan = chat.plan(chat.root, octo(), &lanes).await?;
        let free: Vec<u8> = (1..=8)
            .filter(|face| ![1, sol_face].contains(face))
            .collect();
        assert!(free.contains(&legacy_face(&max.to_string())));
        assert_eq!(
            chat.faces(plan, &lanes).await?,
            stamps((0..lanes.len()).map(|lane| free[lane % free.len()]))
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_lane_named_like_a_saved_agent_runs_as_it_and_wears_its_face() -> anyhow::Result<()> {
    let chat = FaceChat::new("a lane named like a saved agent").await?;
    chat.run(async {
        let pia = Uuid::new_v4();
        chat.save_agent(pia, "pia", "hatchling:1").await?;
        let plan = chat
            .plan(chat.root, octo(), &["scout", "pia", "wren"])
            .await?;
        assert_eq!(
            chat.lane(plan, "pia").await?.agent_id,
            Some(pia.to_string())
        );
        // The other lanes keep off Pia's face.
        assert_eq!(
            chat.faces(plan, &["scout", "pia", "wren"]).await?,
            stamps([2, 1, 3])
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_lane_dispatched_before_faces_keeps_its_handle_seed_through_reruns() -> anyhow::Result<()>
{
    let chat = FaceChat::new("a lane dispatched before faces").await?;
    chat.run(async {
        let plan = chat.plan(chat.root, octo(), &["release_note"]).await?;
        let lane = chat.lane(plan, "release_note").await?;
        // As a controller that stamped no faces dispatched it: its handle is its seed.
        chat.state
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs
                 set payload = jsonb_set(payload, '{metadata,agent,avatarSeed}', '\"release_note\"')
                 where id = $1",
                &[&lane.id],
            )
            .await?;
        chat.end(&[lane.id]).await?;
        let lane = chat.job(lane.id).await?;
        let continued = chat.rerun(&lane, continuation_of(&lane)).await?;
        chat.end(&[continued.id]).await?;
        let continued = chat.job(continued.id).await?;
        let retried = chat
            .rerun(&continued, rate_limit_retry_of(&continued))
            .await?;
        for rerun in [&continued, &retried] {
            assert_eq!(rerun.seed.as_deref(), Some("release_note"), "{rerun:?}");
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn an_ai_asked_again_gets_its_face_back_unless_another_wears_it_now() -> anyhow::Result<()> {
    let chat = FaceChat::new("a returning AI's face").await?;
    chat.run(async {
        let ben = chat.send(chat.root, "ben").await?;
        assert_eq!(ben.seed.as_deref(), Some("hatchling:1"));
        chat.end(&[ben.id]).await?;
        // Faces nobody wore would come first, but Ben comes back to his.
        let ben = chat.send(chat.root, "ben").await?;
        assert_eq!(ben.seed.as_deref(), Some("hatchling:1"));
        chat.end(&[ben.id]).await?;
        // Seven helpers wear the other faces and end, so the next new AI takes
        // the face worn longest ago: Ben's.
        let helpers = ["l2", "l3", "l4", "l5", "l6", "l7", "l8"];
        let plan = chat.plan(chat.root, octo(), &helpers).await?;
        assert_eq!(chat.faces(plan, &helpers).await?, stamps(2..=8));
        chat.end_plan(plan).await?;
        let plan = chat.plan(chat.root, octo(), &["sam"]).await?;
        assert_eq!(chat.faces(plan, &["sam"]).await?, stamps([1]));
        // While Sam wears it, Ben gets another.
        let ben = chat.send(chat.root, "ben").await?;
        assert_eq!(ben.seed.as_deref(), Some("hatchling:2"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_leads_follow_up_to_a_helper_keeps_the_helpers_face() -> anyhow::Result<()> {
    let chat = FaceChat::new("a lead's follow-up to a helper").await?;
    chat.run(async {
        let plan = chat.plan(chat.root, octo(), &["scout", "reading_list"]).await?;
        assert_eq!(
            chat.faces(plan, &["scout", "reading_list"]).await?,
            stamps([1, 2])
        );
        chat.end_plan(plan).await?;
        // The lead's next turn asks the helper again from its own job, as
        // `instafy chat "@reading_list …"` does in a runtime.
        let lead = chat.send(chat.root, "octo").await?;
        let token = chat.job_token(&lead).await?;
        let app = crate::conversations::router().with_state(chat.state.clone());
        let (status, sent) = post(
            app,
            &format!("/conversations/{}/messages", chat.root),
            &token,
            json!({
                "promptText": "@reading_list check the appendix too",
                "intent": "feature",
                "metadata": {"agentSelection": {"active": ["reading_list"], "mentions": ["reading_list"]}},
            }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{sent}");
        let job = Uuid::parse_str(sent["jobId"].as_str().unwrap_or_default())?;
        let follow_up = chat.job(job).await?;
        assert_eq!(follow_up.handle, "reading_list");
        assert_eq!(follow_up.seed.as_deref(), Some("hatchling:2"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_thread_shares_its_chats_faces() -> anyhow::Result<()> {
    let chat = FaceChat::new("a thread's faces").await?;
    chat.run(async {
        let plan = chat.plan(chat.root, octo(), &["rook", "knight"]).await?;
        assert_eq!(chat.faces(plan, &["rook", "knight"]).await?, stamps([1, 2]));
        // A new AI in the thread keeps off the faces at work in the chat...
        let bishop = chat.send(chat.thread, "bishop").await?;
        assert_eq!(bishop.seed.as_deref(), Some("hatchling:3"));
        // ...and an AI of the chat wears its own face there.
        let knight = chat.send(chat.thread, "knight").await?;
        assert_eq!(knight.seed.as_deref(), Some("hatchling:2"));
        // Asked in the thread once the chat's helpers ended, one still comes back to its face.
        chat.end_plan(plan).await?;
        let rook = chat.send(chat.thread, "rook").await?;
        assert_eq!(rook.seed.as_deref(), Some("hatchling:1"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_lane_an_older_runtime_named_ai_runs_again_under_its_name() -> anyhow::Result<()> {
    let chat = FaceChat::new("a lane named ai").await?;
    chat.run(async {
        // A runtime renames a lane named like Octo before it posts the plan; one from before
        // that runs as written. `ai` is Octo's alias, so it is given no face.
        let ben = chat.send(chat.root, "ben").await?;
        assert_eq!(ben.seed.as_deref(), Some("hatchling:1"));
        chat.execute_plan(&ben, &["ai", "scout"]).await?;
        assert_eq!(
            chat.faces(ben.id, &["ai", "scout"]).await?,
            ["ai", "hatchling:2"]
        );
        // Its plan seed still names it, so its next turn and its retry find it.
        let lane = chat.lane(ben.id, "ai").await?;
        chat.end(&[lane.id]).await?;
        let lane = chat.job(lane.id).await?;
        let continued = chat.rerun(&lane, continuation_of(&lane)).await?;
        chat.end(&[continued.id]).await?;
        let continued = chat.job(continued.id).await?;
        let retried = chat
            .rerun(&continued, rate_limit_retry_of(&continued))
            .await?;
        for rerun in [&continued, &retried] {
            assert_eq!(rerun.handle, "ai", "{rerun:?}");
            assert_eq!(rerun.seed.as_deref(), Some("ai"), "{rerun:?}");
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_helpers_cards_go_to_its_lead_and_make_no_saved_agent() -> anyhow::Result<()> {
    let chat = FaceChat::new("a helper's context cards").await?;
    chat.run(async {
        let app = crate::agent_contexts::router().with_state(chat.state.clone());
        let save = |token: String, agent: &'static str| {
            let (app, uri) = (
                app.clone(),
                format!("/projects/{}/agent-contexts", chat.project),
            );
            let card = json!({
                "agent": agent,
                "scopeKind": "conversation",
                "scopeId": chat.root,
                "title": "Sources",
                "context": "The appendix lists the sources.",
            });
            async move { post(app, &uri, &token, card).await }
        };
        // An Octo-led helper saves cards from its turn, under its own name and under another
        // that no agent has: both are Octo's.
        let plan = chat.plan(chat.root, octo(), &["reading_list"]).await?;
        let lane = chat.lane(plan, "reading_list").await?;
        assert_eq!(lane.seed.as_deref(), Some("hatchling:1"));
        let token = chat.job_token(&lane).await?;
        for agent in ["reading_list", "notes"] {
            let (status, card) = save(token.clone(), agent).await?;
            assert_eq!(status, StatusCode::OK, "{card}");
            assert_eq!(card["agent"]["handle"], "octo", "{card}");
        }
        // A saved agent's helper saves under that agent.
        let pia = Uuid::new_v4();
        chat.save_agent(pia, "pia", "hatchling:8").await?;
        let lead = json!({"handle": "pia", "id": pia, "avatarSeed": "hatchling:8"});
        let plan = chat.plan(chat.root, lead, &["scout"]).await?;
        let scout = chat.lane(plan, "scout").await?;
        let (status, card) = save(chat.job_token(&scout).await?, "scout").await?;
        assert_eq!(status, StatusCode::OK, "{card}");
        assert_eq!(card["agent"]["id"], json!(pia), "{card}");
        // No job made a saved agent, so the helpers stay helpers of this chat.
        let handles: Vec<String> = chat
            .state
            .pool
            .get()
            .await?
            .query(
                "select handle from user_agents where user_id = $1 order by handle",
                &[&chat.owner],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        assert_eq!(handles, ["octo", "pia"]);
        chat.end(&[lane.id]).await?;
        let lane = chat.job(lane.id).await?;
        let continued = chat.rerun(&lane, continuation_of(&lane)).await?;
        assert_eq!(continued.agent_id, None);
        assert_eq!(continued.seed.as_deref(), Some("hatchling:1"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_persons_message_carries_no_ai_identity_of_its_own() -> anyhow::Result<()> {
    let chat = FaceChat::new("a person's claimed AI identity").await?;
    chat.run(async {
        let claim =
            json!({"agent": {"handle": "pia", "id": Uuid::new_v4(), "avatarSeed": "hatchling:5"}});
        let ben = chat
            .send_as(&chat.member(), chat.root, "ben", claim.clone())
            .await?;
        assert_eq!(ben.seed.as_deref(), Some("hatchling:1"));
        let sent = chat.sent_message(&ben).await?;
        for key in ["agent", "sourceAgentId"] {
            assert!(sent.get(key).is_none(), "{sent}");
        }
        assert!(sent["prompt_metadata"].get("agent").is_none(), "{sent}");
        // The controller's own dispatches keep what they say.
        let service = RequestContext {
            user_id: Some(chat.owner),
            is_service_role: true,
            scoped_claims: None,
        };
        let sam = chat
            .send_as(&service, chat.root, "sam", claim.clone())
            .await?;
        assert_eq!(chat.sent_message(&sam).await?["agent"], claim["agent"]);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_plans_notices_speak_as_its_lead() -> anyhow::Result<()> {
    let chat = FaceChat::new("a plan's notices").await?;
    chat.run(async {
        // The test's space has no runtime that can start, so each dispatch posts a
        // runtime alert. Ben's own turn speaks as Ben, with the face he was given.
        let ben = chat.send(chat.root, "ben").await?;
        assert_eq!(ben.seed.as_deref(), Some("hatchling:1"));
        let ben_speaks = json!({"handle": "ben", "displayName": null, "avatarSeed": "hatchling:1"});
        assert_eq!(chat.alerts(&[ben.run]).await?, [ben_speaks.clone()]);
        // The plan he posts from that turn speaks as him too, not as its first lane.
        chat.execute_plan(&ben, &["scout", "wren"]).await?;
        assert_eq!(
            chat.faces(ben.id, &["scout", "wren"]).await?,
            stamps([2, 3])
        );
        let runs: Vec<Option<Uuid>> = chat
            .lanes(ben.id)
            .await?
            .iter()
            .map(|lane| lane.run)
            .collect();
        assert_eq!(chat.alerts(&runs).await?, [ben_speaks]);
        // An Octo-led plan speaks as Octo.
        let plan = chat.plan(chat.root, octo(), &["north"]).await?;
        let runs: Vec<Option<Uuid>> = chat
            .lanes(plan)
            .await?
            .iter()
            .map(|lane| lane.run)
            .collect();
        assert_eq!(chat.alerts(&runs).await?, [octo()]);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_face_that_cannot_be_read_leaves_the_ai_its_handles_face() -> anyhow::Result<()> {
    let chat = FaceChat::new("a face that cannot be read").await?;
    chat.run(async {
        // A send in the thread waits for the chat's faces, and its wait fails, as Postgres fails
        // a deadlock's victim's: the send goes on without a face instead of failing.
        let lock = FaceLock::hold(chat.root).await?;
        let (sent, canceled) =
            tokio::join!(chat.send(chat.thread, "sam"), chat.cancel_wait_for(&lock));
        canceled?;
        lock.release().await?;
        let sam = sent?;
        assert_eq!(sam.handle, "sam");
        assert_eq!(sam.seed.as_deref(), Some("sam"), "{sam:?}");
        let message = chat.sent_message(&sam).await?;
        assert!(message.is_object(), "the person's message is recorded");
        // The next AI asked for gets its face as usual.
        let ben = chat.send(chat.thread, "ben").await?;
        assert_eq!(ben.seed.as_deref(), Some("hatchling:1"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_lead_keeps_its_face_while_its_helpers_work_and_until_it_continues() -> anyhow::Result<()>
{
    let chat = FaceChat::new("a lead's face").await?;
    chat.run(async {
        // Ben plans from his own turn, wearing face 1; Scout takes 2.
        let ben = chat.send(chat.root, "ben").await?;
        assert_eq!(ben.seed.as_deref(), Some("hatchling:1"));
        chat.execute_plan(&ben, &["scout"]).await?;
        assert_eq!(chat.faces(ben.id, &["scout"]).await?, stamps([2]));
        // The other faces are worn after Ben's planning turn ended, so his is the face worn
        // longest ago: the next new AI would take it if nothing held it.
        let others = ["l3", "l4", "l5", "l6", "l7", "l8"];
        let plan = chat.plan(chat.root, octo(), &others).await?;
        assert_eq!(chat.faces(plan, &others).await?, stamps(3..=8));
        chat.end_plan(plan).await?;
        // While Scout works, Ben's face is his.
        let sam = chat.send(chat.root, "sam").await?;
        assert_eq!(sam.seed.as_deref(), Some("hatchling:3"));
        // Once Scout ends, Ben's face stays his while his continuation is on its way.
        let scout = chat.lane(ben.id, "scout").await?;
        chat.end(&[scout.id]).await?;
        let max = chat.send(chat.root, "max").await?;
        assert_eq!(max.seed.as_deref(), Some("hatchling:4"));
        // A lead whose helpers ended long ago holds nothing.
        chat.ended_ago(scout.id, 10).await?;
        let kim = chat.send(chat.root, "kim").await?;
        assert_eq!(kim.seed.as_deref(), Some("hatchling:1"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_question_keeps_its_lanes_face_until_it_is_resumed() -> anyhow::Result<()> {
    let chat = FaceChat::new("a question's face").await?;
    chat.run(async {
        // Tester's turn asks a question and ends; the other faces are worn after it, so its face
        // is the one worn longest ago.
        let plan = chat.plan(chat.root, octo(), &["tester"]).await?;
        let tester = chat.lane(plan, "tester").await?;
        assert_eq!(tester.seed.as_deref(), Some("hatchling:1"));
        chat.end(&[tester.id]).await?;
        chat.ask(&tester, "pending").await?;
        let others = ["l2", "l3", "l4", "l5", "l6", "l7", "l8"];
        let plan = chat.plan(chat.root, octo(), &others).await?;
        assert_eq!(chat.faces(plan, &others).await?, stamps(2..=8));
        chat.end_plan(plan).await?;
        // Asked, and then answered, the question keeps Tester's face Tester's.
        let sam = chat.send(chat.root, "sam").await?;
        assert_eq!(sam.seed.as_deref(), Some("hatchling:2"));
        chat.ask(&tester, "answered").await?;
        let max = chat.send(chat.root, "max").await?;
        assert_eq!(max.seed.as_deref(), Some("hatchling:3"));
        // Resumed, it holds nothing: the turn it resumed wears the face instead.
        chat.ask(&tester, "resumed").await?;
        let kim = chat.send(chat.root, "kim").await?;
        assert_eq!(kim.seed.as_deref(), Some("hatchling:1"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_saved_agent_wears_the_face_its_owner_picks_after_it_ran() -> anyhow::Result<()> {
    let chat = FaceChat::new("a saved agent's new face").await?;
    chat.run(async {
        // Pia ran with a picture, which holds no face; then her owner picked face 1.
        let pia = Uuid::new_v4();
        chat.save_agent(pia, "pia", "https://cdn.example.com/pia.png")
            .await?;
        let ran = chat.send(chat.root, "pia").await?;
        assert_eq!(ran.agent_id, Some(pia.to_string()));
        chat.end(&[ran.id]).await?;
        chat.state
            .pool
            .get()
            .await?
            .execute(
                "update user_agents set avatar_seed = 'hatchling:1' where id = $1",
                &[&pia],
            )
            .await?;
        // The chat shows Pia as her profile does now, so helpers keep off face 1.
        let plan = chat.plan(chat.root, octo(), &["scout", "wren"]).await?;
        assert_eq!(chat.faces(plan, &["scout", "wren"]).await?, stamps([2, 3]));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_long_turn_that_just_ended_counts_as_just_worn() -> anyhow::Result<()> {
    let chat = FaceChat::new("a long turn's face").await?;
    chat.run(async {
        // Rook works while 200 newer turns run in the chat, then ends: its face was worn last,
        // so the next new AI takes a face nobody wore.
        let plan = chat.plan(chat.root, octo(), &["rook"]).await?;
        let rook = chat.lane(plan, "rook").await?;
        assert_eq!(rook.seed.as_deref(), Some("hatchling:1"));
        chat.octo_turns(chat.root, 200).await?;
        chat.end(&[rook.id]).await?;
        let sam = chat.send(chat.root, "sam").await?;
        assert_eq!(sam.seed.as_deref(), Some("hatchling:2"));
        Ok(())
    })
    .await
}
