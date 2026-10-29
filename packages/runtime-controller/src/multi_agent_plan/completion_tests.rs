use super::*;
use crate::tests_managed_ai_refund::{
    credit_balance, daily_prompts_used, ledger_rows, run_row, seed_reserved_managed_ai_prompt,
    ReservedManagedAiPrompt,
};
use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
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
