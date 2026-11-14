//! Use the real checkpoint dispatcher and completion/cancellation endpoints. An
//! early lead must finish before a final lead can publish a newer group snapshot.

use super::*;
use crate::background_loops::TickConnection;

async fn final_checkpoints(
    pool: &PgPool,
    conversation: Uuid,
    group: Uuid,
) -> anyhow::Result<Vec<tokio_postgres::Row>> {
    Ok(pool.get().await?.query(
        "select id, created_at, payload from agent_jobs where conversation_id=$1
         and payload #>> '{metadata,multiAgentPlan,role}'='lead_continuation'
         and payload #>> '{metadata,multiAgentPlan,groupId}'=$2::uuid::text
         and coalesce(payload #>> '{metadata,multiAgentPlan,checkpointKind}','') <> 'early_failure'",
        &[&conversation, &group],
    ).await?)
}

/// The lost-final-lead sweep reads every conversation: keep these two tests,
/// which seed groups it owes, from trying one another's. The tests that tick
/// it through `sweep_idle_activity` take no lock: like the rest of the database
/// suite, they rely on the serial runner (`scripts/test-controller.mjs`).
static LOST_FINAL_LEAD_SWEEP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Wakes the goal from `source`'s wakeup as a completion does, once it is due,
/// and returns how the wake left it: `pending` when the goal's next turn waits
/// (it is retried in 30 s), else `dispatched` or the like. A wait is a conflict,
/// so it records neither an attempt nor an error, unlike a failed dispatch's retry.
async fn wake_goal(state: &AppState, pool: &PgPool, source: Uuid) -> anyhow::Result<String> {
    let connection = pool.get().await?;
    connection
        .execute(
            "update conversation_goal_continuations set next_attempt_at=now()
        where source_job_id=$1 and status='pending'",
            &[&source],
        )
        .await?;
    crate::conversation_goals::wake_after_completion(state.clone(), source);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let row = connection
            .query_one(
                "select status, next_attempt_at > now() + interval '15 seconds' as deferred,
                attempts, error
            from conversation_goal_continuations where source_job_id=$1",
                &[&source],
            )
            .await?;
        let status: String = row.get("status");
        if status != "claimed" && (status != "pending" || row.get::<_, bool>("deferred")) {
            let error: Option<String> = row.get("error");
            anyhow::ensure!(
                status != "pending" || (row.get::<_, i32>("attempts") == 0 && error.is_none()),
                "the goal's wake failed instead of waiting: {error:?}"
            );
            return Ok(status);
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "the goal's wake did not settle: {status}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
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
            // Checkpoints inherit the real planning job's research budget, so the
            // fixture must retain that job and the workers' stored parent links.
            connection.execute(
                "insert into agent_jobs(id,project_id,conversation_id,status,outcome,completed_at,payload)
                 values($1,$2,$3,'completed','succeeded',now(),'{}'::jsonb)",
                &[&parent_job,&space.project_id,&conversation],
            ).await?;
            connection.execute(
                "update agent_jobs set parent_job_id=$2 where id=any($1::uuid[])",
                &[&vec![first,second],&parent_job],
            ).await?;
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
                assert!(final_checkpoints(&pool, conversation, group).await?.is_empty(), "{ending}: active early lead cannot be overtaken");
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
                    let rows = final_checkpoints(&pool, conversation, group).await?;
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
            let final_rows = final_checkpoints(&pool, conversation, group).await?;
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

/// A last worker's end can commit without its settlement queuing the final
/// lead: the controller restarted, or the dispatch failed and was only logged.
/// The idle sweep queues that lead once the settlement has had its grace
/// period, exactly once, from a fresh group snapshot with the last worker as
/// its trigger. It leaves alone a group still settling, one too old to revive,
/// a deleted space, a stopped group, one whose lead managed AI refused, one
/// that already has a lead, one whose last worker a person's runtime stop
/// expired, one whose last worker planned again, and one that lost a worker to
/// a deleted AI connection, which owes no lead and tells the person nothing
/// even once the conversation moved on; another space's jobs
/// carrying the group's ids are neither its lead nor its plan. When the conversation
/// moved on, or a refused lead has been retried long enough, the person is
/// told once instead, and nothing starts that lead afterwards; a lead refused
/// for less long is retried. What belongs to a turn received before the workers
/// ended is no new turn, even when it happens after they end: a steer of a turn
/// still running, an answer to a worker's question given with Reply, a send
/// queued before they ended, which is answered first while the lead follows it,
/// even when that takes longer than a refusal is retried, and the jobs of a
/// team such a turn planned, however deep its plans nest, with a steer of them:
/// the lead of another team such a turn planned, which this lead waits behind.
/// Of two lost leads for one agent, the team that ended first is tried first,
/// so its summary comes first. A send queued after they ended counts as moving on, and so does a
/// turn that started after they ended, even with no message of the person's.
/// A goal-bound lead carries the planning turn's
/// goal, and giving up blocks that goal unless a newer turn carries it. The
/// goal's next turn waits for exactly the groups of its conversation the sweep
/// still owes a lead, from the moment their workers end: after a queued answer
/// it follows the summary instead of giving it up.
#[tokio::test]
async fn a_lost_final_lead_handoff_is_recovered_by_the_idle_sweep() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping lost final lead recovery: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let _sweep = LOST_FINAL_LEAD_SWEEP.lock().await;
    let notice_text =
        "@octo could not continue the plan after its agents finished. Their results are in the plan.";
    for case in [
        "recovered",
        "settling",
        "too_old",
        "deleted",
        "stopped",
        "refused",
        "led",
        "led_elsewhere",
        "person_stopped",
        "nested",
        "moved_on",
        "failing",
        "given_up",
        "queued",
        "queued_late",
        "steered",
        "answered",
        "follow_on",
        "sibling",
        "two_lost",
        "turn_started",
        "lost_credential",
        "lost_credential_moved_on",
        "goal_recovered",
        "goal_given_up",
        "goal_moved_on",
        "goal_queued",
        "goal_answered",
    ] {
        // `goal_<base>` is `<base>` with the planning turn holding the conversation's goal.
        let (goal, base) = match case.strip_prefix("goal_") {
            Some(base) => (true, base),
            None => (false, case),
        };
        let space = ManagedSpace::seed(pool.clone(), "lost-final-lead").await?;
        let result: anyhow::Result<()> = async {
            let state = build_test_state(pool.clone(), space.config("lost-final-lead"));
            let mut events = state.events.subscribe();
            let tick = || {
                let (state, pool) = (&state, &pool);
                async move {
                    crate::runtime::recover_lost_final_plan_checkpoints(state, &mut TickConnection::new(pool)).await
                }
            };
            let group = Uuid::new_v4();
            let parent_job = Uuid::new_v4();
            let plan = json!({"groupId":group,"role":"worker","mode":"read_only",
                "parentJobId":parent_job,"parentRuntimeId":space.hosted_runtime_id,
                "lead":{"leadHandle":"octo","continuationPrompt":"Summarize the verified results."}});
            let (conversation, first, _) = insert_finished_plan_lane(&space, None, "alpha", plan.clone(), json!({})).await?;
            let (_, last, _) = insert_finished_plan_lane(&space, Some(conversation), "beta", plan, json!({})).await?;
            // A queued send keeps the lead's lane busy for longer than a refusal is retried.
            let ended_ago: i64 = match base {
                "settling" => 30,
                "too_old" => 3 * 3600,
                "given_up" | "queued" => 20 * 60,
                _ => 5 * 60,
            };
            let connection = pool.get().await?;
            // The planning job the workers came from: the lead inherits its research budget.
            // It started before the workers ended, so it is no newer turn. Every job is
            // received when its dispatch admits it, as `enqueue_agent_job_record` stamps it.
            connection.execute("insert into agent_jobs(id,project_id,conversation_id,status,outcome,created_at,trigger_received_at,completed_at,payload)
                values($1,$2,$3,'completed','succeeded',now()-($4::bigint*interval '1 second'),now()-($4::bigint*interval '1 second'),
                    now()-($5::bigint*interval '1 second'),'{}'::jsonb)",
                &[&parent_job,&space.project_id,&conversation,&(ended_ago+300),&(ended_ago+120)]).await?;
            // The hierarchy columns the controller's dispatch fills for every worker, which the
            // planning turn admitted before it ended.
            connection.execute("update agent_jobs set agent_role='worker',plan_group_id=$2,parent_job_id=$4,
                created_at=now()-(($3::bigint+120)*interval '1 second'),trigger_received_at=now()-(($3::bigint+120)*interval '1 second'),
                completed_at=now()-($3::bigint*interval '1 second') where id=$1", &[&first,&group,&(ended_ago+60),&parent_job]).await?;
            connection.execute("update agent_jobs set agent_role='worker',plan_group_id=$2,parent_job_id=$4,summary='LATEST VERIFIED RESULT',
                created_at=now()-(($3::bigint+120)*interval '1 second'),trigger_received_at=now()-(($3::bigint+120)*interval '1 second'),
                completed_at=now()-($3::bigint*interval '1 second') where id=$1", &[&last,&group,&ended_ago,&parent_job]).await?;
            let (goal_id, revision, owner_revision) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
            if goal {
                // The person's goal turn planned the team: the planning job holds the goal's
                // revision, and its receipt leaves the goal to the team's final lead.
                let prompt = Uuid::new_v4();
                connection.execute("insert into prompts(id,project_id,conversation_id,user_id,prompt_text)
                    values($1,$2,$3,$4,'Split this review across a team.')",
                    &[&prompt,&space.project_id,&conversation,&space.owner_user_id]).await?;
                connection.execute("update agent_jobs set prompt_id=$2,planning_receipt_state='{}',payload=$3 where id=$1",
                    &[&parent_job,&prompt,&PgJson(json!({"user_id":space.owner_user_id,"metadata":{"_controllerGoal":
                        {"revision":revision,"ownerUserId":space.owner_user_id,"userTurn":true}}}))]).await?;
                connection.execute("update conversations set metadata=coalesce(metadata,'{}'::jsonb)||$2 where id=$1",
                    &[&conversation,&PgJson(json!({
                        "instafyGoal":{"id":goal_id,"objective":"Ship the reviewed change","status":"active"},
                        "_goalController":{"revision":revision,"ownerUserId":space.owner_user_id},
                    }))]).await?;
            }
            let queued_send = Uuid::new_v4();
            let mut other_conversation = None;
            let mut sibling_lead = None;
            let mut second_team = None;
            match base {
                "deleted" => { connection.execute("update projects set status='deleted' where id=$1", &[&space.project_id]).await?; }
                "stopped" => {
                    connection.execute("insert into conversation_messages(id,conversation_id,project_id,role,content,metadata)
                        values(gen_random_uuid(),$1,$2,'assistant','Stopped.',$3)", &[&conversation,&space.project_id,&PgJson(json!({"source":"controller",
                        "kind":"run_cancellation","details":{"stopRequested":true,"suppressedPlanGroupIds":[group]}}))]).await?;
                    // Another conversation's team just ended and is owed its own lead.
                    let other_group = Uuid::new_v4();
                    let (other, other_worker, _) = insert_finished_plan_lane(&space, None, "gamma",
                        json!({"groupId":other_group,"role":"worker","mode":"read_only","lead":{"leadHandle":"octo"}}), json!({})).await?;
                    connection.execute("update agent_jobs set agent_role='worker',plan_group_id=$2 where id=$1",
                        &[&other_worker,&other_group]).await?;
                    other_conversation = Some(other);
                }
                "refused" => {
                    // Managed AI refused the lead and said so: it never starts, and nothing retries it.
                    connection.execute("insert into conversation_messages(id,conversation_id,project_id,role,content,metadata)
                        values(gen_random_uuid(),$1,$2,'assistant','Instafy AI runs on Instafy-hosted runtimes.',$3)",
                        &[&conversation,&space.project_id,&PgJson(json!({"source":"controller",
                        "kind":crate::dispatch::MANAGED_AI_HOSTED_RUNTIME_REQUIRED_CODE,"messageType":"error",
                        "multiAgentPlan":{"groupId":group,"role":"lead_continuation","checkpointKind":"final"}}))]).await?;
                }
                "led" => { connection.execute("insert into agent_jobs(project_id,conversation_id,status,completed_at,payload,plan_group_id,agent_role)
                    values($1,$2,'failed',now(),$3,$4,'lead_continuation')", &[&space.project_id,&conversation,
                    &PgJson(json!({"metadata":{"multiAgentPlan":{"groupId":group,"role":"lead_continuation"}}})),&group]).await?; }
                "led_elsewhere" => {
                    // Another space holds a lead carrying this team's group, and a job naming the
                    // team's last worker as its parent: neither speaks for this team.
                    let (elsewhere, chat) = (Uuid::new_v4(), Uuid::new_v4());
                    connection.execute("insert into projects(id,org_id,owner_user_id,project_type,status)
                        values($1,$2,$3,'customer','active')", &[&elsewhere,&space.org_id,&space.owner_user_id]).await?;
                    connection.execute("insert into conversations(id,project_id,created_by,metadata,visibility)
                        values($1,$2,$3,'{}','public')", &[&chat,&elsewhere,&space.owner_user_id]).await?;
                    connection.execute("insert into agent_jobs(project_id,conversation_id,status,completed_at,payload,plan_group_id,agent_role)
                        values($1,$2,'failed',now(),$3,$4,'lead_continuation')", &[&elsewhere,&chat,
                        &PgJson(json!({"metadata":{"multiAgentPlan":{"groupId":group,"role":"lead_continuation"}}})),&group]).await?;
                    connection.execute("insert into agent_jobs(project_id,conversation_id,status,completed_at,payload,plan_group_id,agent_role,parent_job_id)
                        values($1,$2,'completed',now(),'{}',$3,'worker',$4)", &[&elsewhere,&chat,&Uuid::new_v4(),&last]).await?;
                }
                "person_stopped" => { connection.execute("update agent_jobs set status='failed',outcome='expired',error_message=$2,
                    payload=jsonb_set(payload,'{requeuedReason}','\"user_stop\"') where id=$1",
                    &[&last,&crate::runtime::REQUEUED_JOB_EXPIRED_MESSAGE]).await?; }
                "nested" => {
                    // The last worker planned again: its own team is a different group.
                    let inner = Uuid::new_v4();
                    connection.execute("insert into agent_jobs(project_id,conversation_id,status,completed_at,payload,plan_group_id,agent_role,parent_job_id)
                        values($1,$2,'completed',now(),$3,$4,'worker',$5)", &[&space.project_id,&conversation,
                        &PgJson(json!({"metadata":{"multiAgentPlan":{"groupId":inner,"role":"worker"}}})),&inner,&last]).await?;
                }
                "moved_on" => {
                    connection.execute("insert into conversation_messages(id,conversation_id,project_id,role,content,metadata,created_by)
                        values(gen_random_uuid(),$1,$2,'user','Now wire it into the CLI.','{}',$3)",
                        &[&conversation,&space.project_id,&space.owner_user_id]).await?;
                    if goal {
                        // That send replaced the goal turn, as `bind_dispatch` does for a person's own send.
                        connection.execute("update conversations set metadata=jsonb_set(metadata,'{_goalController,revision}',to_jsonb($2::text)) where id=$1",
                            &[&conversation,&owner_revision.to_string()]).await?;
                    }
                }
                "queued" | "queued_late" => {
                    // The person queued a send for the lead's agent while its team worked, or once it had ended.
                    let queued_ago = if base == "queued_late" { 0 } else { ended_ago + 30 };
                    connection.execute("insert into conversation_send_queue(id,project_id,conversation_id,user_id,status,request,created_at)
                        values($1,$2,$3,$4,'queued',$5,now()-($6::bigint*interval '1 second'))",
                        &[&queued_send,&space.project_id,&conversation,&space.owner_user_id,&PgJson(json!({
                            "promptText":"Now summarize a separate document.","intent":"feature",
                            "metadata":{"agentSelection":{"active":["octo"],"mentions":[]}},
                            "runtimeId":space.hosted_runtime_id,
                        })),&queued_ago]).await?;
                }
                "steered" => {
                    // Before the workers ended, the person asked @scribe something; once they
                    // ended, the person steered that still-running turn. A steer adds a message
                    // to the turn it steers and starts no job.
                    let prompt = Uuid::new_v4();
                    connection.execute("insert into prompts(id,project_id,conversation_id,user_id,prompt_text)
                        values($1,$2,$3,$4,'Check the release notes.')",
                        &[&prompt,&space.project_id,&conversation,&space.owner_user_id]).await?;
                    connection.execute("insert into agent_jobs(project_id,conversation_id,prompt_id,status,created_at,trigger_received_at,payload)
                        values($1,$2,$3,'leased',now()-($4::bigint*interval '1 second'),now()-($4::bigint*interval '1 second'),$5)",
                        &[&space.project_id,&conversation,&prompt,&(ended_ago+90),
                          &PgJson(json!({"metadata":{"agent":{"handle":"scribe"}}}))]).await?;
                    connection.execute("insert into conversation_messages(id,conversation_id,project_id,role,content,metadata,created_by,prompt_id)
                        values(gen_random_uuid(),$1,$2,'user','Also check the changelog.',$3,$4,$5)",
                        &[&conversation,&space.project_id,&PgJson(json!({"sendIntent":{"mode":"steer","state":"delivered"}})),
                          &space.owner_user_id,&prompt]).await?;
                }
                "answered" => {
                    // The last worker asked the person a question and ended. Once the team had
                    // ended, the person answered it, but the answer expired without resuming the
                    // worker (no team time left, say). The answer belongs to the workers' turn:
                    // they share the plan's prompt, as dispatch gives it to them.
                    let (prompt, request, answer) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
                    connection.execute("insert into prompts(id,project_id,conversation_id,user_id,prompt_text)
                        values($1,$2,$3,$4,'Split this review across a team.')",
                        &[&prompt,&space.project_id,&conversation,&space.owner_user_id]).await?;
                    connection.execute("update agent_jobs set prompt_id=$2 where id=any($1)", &[&vec![first,last],&prompt]).await?;
                    connection.execute("insert into conversation_messages(id,conversation_id,project_id,role,content,metadata,created_by,prompt_id)
                        values($1,$2,$3,'user','Use the staging data.',$4,$5,$6)",
                        &[&answer,&conversation,&space.project_id,&PgJson(json!({"userInputRequestId":request})),
                          &space.owner_user_id,&prompt]).await?;
                    connection.execute("insert into agent_user_input_requests(id,project_id,conversation_id,job_id,prompt_id,lease_attempt,
                            group_id,agent_handle,questions,continuation_note,status,expired_reason,answers,answer_message_id,answered_by,answered_at)
                        values($1,$2,$3,$4,$5,1,$6,'beta','[]','Continue with the answer.','expired','team_time','{}',$7,$8,now())",
                        &[&request,&space.project_id,&conversation,&last,&prompt,&group,&answer,&space.owner_user_id]).await?;
                }
                "follow_on" => {
                    // The person queued a send for @scribe while the workers ran; it went out once
                    // they had ended, received when it was queued. Its answer planned a team, and
                    // that team's helper planned again. Their helpers are queued.
                    let planner = Uuid::new_v4();
                    connection.execute("insert into agent_jobs(id,project_id,conversation_id,status,outcome,created_at,trigger_received_at,completed_at,payload)
                        values($1,$2,$3,'completed','succeeded',now()-($4::bigint*interval '1 second'),now()-($5::bigint*interval '1 second'),now(),$6)",
                        &[&planner,&space.project_id,&conversation,&(ended_ago-30),&(ended_ago+90),
                          &PgJson(json!({"metadata":{"agent":{"handle":"scribe"}}}))]).await?;
                    let mut parent = planner;
                    for (handle, after_end) in [("gamma", 60_i64), ("delta", 90)] {
                        let (helper, team) = (Uuid::new_v4(), Uuid::new_v4());
                        connection.execute("insert into agent_jobs(id,project_id,conversation_id,status,created_at,trigger_received_at,payload,plan_group_id,agent_role,parent_job_id)
                            values($1,$2,$3,'queued',now()-($4::bigint*interval '1 second'),now()-($4::bigint*interval '1 second'),$5,$6,'worker',$7)",
                            &[&helper,&space.project_id,&conversation,&(ended_ago-after_end),
                              &PgJson(json!({"metadata":{"agent":{"handle":handle},
                                  "multiAgentPlan":{"groupId":team,"role":"worker","parentJobId":parent}}})),&team,&parent]).await?;
                        parent = helper;
                    }
                }
                "sibling" => {
                    // A turn received before the workers ended planned another team, which ended
                    // after them. Its own lead for @octo started then, and the person steered it.
                    let (team, planner, prompt) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
                    connection.execute("insert into agent_jobs(id,project_id,conversation_id,status,outcome,created_at,trigger_received_at,completed_at,payload)
                        values($1,$2,$3,'completed','succeeded',now()-($4::bigint*interval '1 second'),now()-($4::bigint*interval '1 second'),
                            now()-($5::bigint*interval '1 second'),'{}'::jsonb)",
                        &[&planner,&space.project_id,&conversation,&(ended_ago+200),&(ended_ago+150)]).await?;
                    connection.execute("insert into prompts(id,project_id,conversation_id,user_id,prompt_text)
                        values($1,$2,$3,$4,'Summarize the other team.')",
                        &[&prompt,&space.project_id,&conversation,&space.owner_user_id]).await?;
                    sibling_lead = Some(connection.query_one("insert into agent_jobs(project_id,conversation_id,prompt_id,status,created_at,trigger_received_at,payload,plan_group_id,agent_role,parent_job_id)
                        values($1,$2,$3,'leased',now()-($4::bigint*interval '1 second'),now()-($4::bigint*interval '1 second'),$5,$6,'lead_continuation',$7)
                        returning id",
                        &[&space.project_id,&conversation,&prompt,&(ended_ago-30),
                          &PgJson(json!({"metadata":{"agent":{"handle":"octo"},
                              "multiAgentPlan":{"groupId":team,"role":"lead_continuation","parentJobId":planner}}})),&team,&planner]).await?
                        .get::<_, Uuid>(0));
                    connection.execute("insert into conversation_messages(id,conversation_id,project_id,role,content,metadata,created_by,prompt_id)
                        values(gen_random_uuid(),$1,$2,'user','Also list the flaky tests.',$3,$4,$5)",
                        &[&conversation,&space.project_id,&PgJson(json!({"sendIntent":{"mode":"steer","state":"delivered"}})),
                          &space.owner_user_id,&prompt]).await?;
                }
                "two_lost" => {
                    // A turn received before the workers ended planned another team for @octo, which
                    // ended a minute after them, and its handoff was lost too.
                    let planner = Uuid::new_v4();
                    connection.execute("insert into agent_jobs(id,project_id,conversation_id,status,outcome,created_at,trigger_received_at,completed_at,payload)
                        values($1,$2,$3,'completed','succeeded',now()-($4::bigint*interval '1 second'),now()-($4::bigint*interval '1 second'),
                            now()-($5::bigint*interval '1 second'),'{}'::jsonb)",
                        &[&planner,&space.project_id,&conversation,&(ended_ago+200),&(ended_ago+60)]).await?;
                    let team = Uuid::new_v4();
                    let (_, worker, _) = insert_finished_plan_lane(&space, Some(conversation), "gamma", json!({"groupId":team,
                        "role":"worker","mode":"read_only","parentJobId":planner,"parentRuntimeId":space.hosted_runtime_id,
                        "lead":{"leadHandle":"octo","continuationPrompt":"Summarize the other results."}}), json!({})).await?;
                    connection.execute("update agent_jobs set agent_role='worker',plan_group_id=$2,parent_job_id=$4,
                        created_at=now()-(($3::bigint+120)*interval '1 second'),trigger_received_at=now()-(($3::bigint+120)*interval '1 second'),
                        completed_at=now()-($3::bigint*interval '1 second') where id=$1", &[&worker,&team,&(ended_ago-60),&planner]).await?;
                    second_team = Some(team);
                }
                "turn_started" => {
                    // @scribe's turn started after the workers ended, with no message of the
                    // person's (an automation's, say).
                    connection.execute("insert into agent_jobs(project_id,conversation_id,status,outcome,created_at,trigger_received_at,completed_at,payload)
                        values($1,$2,'completed','succeeded',now()-($3::bigint*interval '1 second'),now()-($3::bigint*interval '1 second'),now(),$4)",
                        &[&space.project_id,&conversation,&(ended_ago-60),
                          &PgJson(json!({"metadata":{"agent":{"handle":"scribe"}}}))]).await?;
                }
                "lost_credential" | "lost_credential_moved_on" => {
                    // The first worker failed when the AI connection it was sent with was deleted,
                    // as `agent_jobs_fail_on_credential_removal` fails it: its plan wakes no lead,
                    // so no lead is owed, and no notice says one could not start, even after the
                    // person wrote in the conversation.
                    connection.execute("update agent_jobs set status='failed',outcome='failed',error_message=$2,
                        credential_removed_at=completed_at where id=$1",
                        &[&first,&crate::runtime::CREDENTIAL_REMOVED_MESSAGE]).await?;
                    if base == "lost_credential_moved_on" {
                        connection.execute("insert into conversation_messages(id,conversation_id,project_id,role,content,metadata,created_by)
                            values(gen_random_uuid(),$1,$2,'user','Connect my AI again.','{}',$3)",
                            &[&conversation,&space.project_id,&space.owner_user_id]).await?;
                    }
                }
                "failing" | "given_up" => {
                    // A Personal Browser runtime refuses any other job: the lead pinned to it never starts.
                    let pinned = Uuid::new_v4();
                    insert_ready_runtime(&pool, &space.project_id, &pinned, "instafy-cloud",
                        json!({"agent":true,"origin":true,"personalBrowser":{}})).await?;
                    connection.execute("update agent_jobs set payload=jsonb_set(payload,'{metadata,runtimePreference}',$2) where id=$1",
                        &[&last,&PgJson(json!({"runtimeId":pinned,"source":"multi_agent_plan_parent"}))]).await?;
                }
                _ => {}
            }
            drop(connection);
            if matches!(base, "queued" | "queued_late") {
                // The send goes before the sweep acts: the settlement drains the queue even when its
                // checkpoint fails, and the queue recovery drains it after a restart.
                crate::send_queue::spawn_send_queue_drain(state.clone(), conversation);
                let deadline = tokio::time::Instant::now()+std::time::Duration::from_secs(10);
                loop {
                    let row = pool.get().await?.query_one("select status,dispatched_run_id,error_message from conversation_send_queue where id=$1", &[&queued_send]).await?;
                    let status: String = row.get("status");
                    if row.get::<_, Option<Uuid>>("dispatched_run_id").is_some() {break;}
                    anyhow::ensure!(status != "failed", "queued send failed: {:?}", row.get::<_,Option<String>>("error_message"));
                    anyhow::ensure!(tokio::time::Instant::now()<deadline, "queued send did not drain: {status}");
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }
            // The goal's next turn waits for exactly the groups of its conversation the sweep still
            // owes a lead, from the moment their workers end. In `nested` that is the team the last
            // worker planned, whose worker just ended: its own lead is owed, inside the grace.
            let owes_in = |conversation: Uuid| {
                let pool = &pool;
                async move {
                    let connection = pool.get().await?;
                    Ok::<_, anyhow::Error>(crate::runtime::conversation_owes_final_lead(&*connection, conversation).await?)
                }
            };
            let owes = || owes_in(conversation);
            assert_eq!(owes().await?, !matches!(base, "too_old" | "deleted" | "stopped" | "refused" | "led" | "person_stopped"
                    | "lost_credential" | "lost_credential_moved_on"),
                "{case}: owed before the sweep");
            if let Some(other) = other_conversation {
                assert!(owes_in(other).await?, "{case}: the other conversation's team is owed its lead");
            }
            // Two ticks: a recovered or given-up group is not touched again.
            tick().await?;
            tick().await?;
            assert_eq!(owes().await?, matches!(base, "settling" | "failing" | "queued" | "nested" | "sibling" | "two_lost"),
                "{case}: owed after the sweep");
            if let Some(other) = other_conversation {
                assert!(owes_in(other).await?, "{case}: the other team is still inside its grace");
            }
            let notices = || {
                let pool = &pool;
                async move {
                    Ok::<_, anyhow::Error>(pool.get().await?.query("select content,metadata from conversation_messages
                        where conversation_id=$1 and metadata->>'kind'=$2",
                        &[&conversation,&crate::multi_agent_plan::LEAD_CHECKPOINT_FAILED_CODE]).await?)
                }
            };
            let finals = final_checkpoints(&pool, conversation, group).await?;
            let told = notices().await?;
            match base {
                "recovered" | "led_elsewhere" | "steered" | "answered" | "follow_on" | "two_lost" => {
                    assert_eq!(finals.len(), 1, "{case}: the lead is recovered");
                    assert!(told.is_empty(), "{case}: no notice");
                    let payload = finals[0].get::<_, PgJson<serde_json::Value>>("payload").0;
                    assert!(payload["prompt_text"].as_str().unwrap().contains("LATEST VERIFIED RESULT"), "fresh group snapshot");
                    assert_eq!(payload["metadata"]["multiAgentPlan"]["triggerJobId"], json!(last), "the last worker to end triggers");
                    assert_eq!(payload["metadata"]["multiAgentPlan"]["lead"]["leadHandle"], json!("octo"));
                }
                "led" => {
                    assert_eq!(finals.len(), 1, "the existing lead is the only one");
                    assert!(told.is_empty());
                }
                "moved_on" | "given_up" | "queued_late" | "turn_started" => {
                    assert!(finals.is_empty(), "{case}: no late lead");
                    assert_eq!(told.len(), 1, "{case}: told once");
                    assert_eq!(told[0].get::<_, String>("content"), notice_text);
                    let metadata = told[0].get::<_, PgJson<serde_json::Value>>("metadata").0;
                    assert_eq!(metadata["multiAgentPlan"]["groupId"], json!(group.to_string()));
                    assert_eq!(metadata["multiAgentPlan"]["role"], json!("lead_continuation"));
                    assert_eq!(metadata["messageType"], json!("error"));
                }
                // `queued` and `sibling`: the lead waits for @octo, without a notice.
                _ => {
                    assert!(finals.is_empty(), "{case}: no lead");
                    assert!(told.is_empty(), "{case}: no notice");
                }
            }
            if matches!(base, "failing" | "given_up") {
                // The failure is the pinned runtime's refusal, a 403.
                let error = crate::multi_agent_plan::recover_lost_final_checkpoint(&state, last).await;
                if base == "failing" {
                    let (status, axum::Json(error)) = error.expect_err("the pinned lead cannot start");
                    assert_eq!(status, StatusCode::FORBIDDEN);
                    assert_eq!(error.message, "Personal Browser runtime is not available to the current user");
                } else {
                    assert!(!error.map_err(|e| controller_error("given-up recovery", e))?, "a given-up lead never starts");
                }
                // Once the pin is gone, a retried group starts its lead, and a given-up one does not:
                // not by the sweep, nor by a replayed completion.
                let payload: serde_json::Value = pool.get().await?.query_one(
                    "update agent_jobs set payload=payload #- '{metadata,runtimePreference}' where id=$1 returning payload",
                    &[&last]).await?.get::<_, PgJson<serde_json::Value>>(0).0;
                tick().await?;
                crate::multi_agent_plan::maybe_enqueue_lead_continuation_after_completion(&state, last, &payload).await
                    .map_err(|e| controller_error("replayed completion", e))?;
                assert_eq!(final_checkpoints(&pool, conversation, group).await?.len(), usize::from(base == "failing"), "{case}");
                assert_eq!(notices().await?.len(), usize::from(base == "given_up"), "{case}");
                assert!(!owes().await?, "{case}: settled");
            }
            if let Some(team) = second_team {
                // The other team's lead waits for @octo behind this one, which is no newer turn
                // for it either, and follows it once it has ended.
                assert!(final_checkpoints(&pool, conversation, team).await?.is_empty(), "the later team waits");
                pool.get().await?.execute("update agent_jobs set status='completed',outcome='succeeded',completed_at=now() where id=$1",
                    &[&finals[0].get::<_, Uuid>("id")]).await?;
                tick().await?;
                assert_eq!(final_checkpoints(&pool, conversation, team).await?.len(), 1, "then its lead follows");
                assert!(notices().await?.is_empty(), "no notice");
                assert!(!owes().await?, "both leads are queued");
            }
            if let Some(sibling_lead) = sibling_lead {
                // The other team's lead and the person's steer of it are no newer turn, as a turn
                // received before the workers ended planned that team. This lead starts once that
                // lead has ended.
                pool.get().await?.execute("update agent_jobs set status='completed',outcome='succeeded',completed_at=now() where id=$1",
                    &[&sibling_lead]).await?;
                tick().await?;
                assert_eq!(final_checkpoints(&pool, conversation, group).await?.len(), 1, "the lead follows the other team's");
                assert!(notices().await?.is_empty(), "no notice");
                assert!(!owes().await?, "the lead is queued");
            }
            if base == "queued" {
                // The drained send kept the time it was queued, so it is no newer turn: its answer
                // holds the lead's lane, and the lead starts once that answer has ended.
                let row = pool.get().await?.query_one(
                    "select j.id, j.payload, j.trigger_received_at, q.created_at as queued_at
                     from conversation_send_queue q join agent_jobs j on j.run_id = q.dispatched_run_id
                     where q.id = $1", &[&queued_send]).await?;
                let answer: Uuid = row.get("id");
                let answer_payload = row.get::<_, PgJson<serde_json::Value>>("payload").0;
                assert_eq!(row.get::<_, Option<chrono::DateTime<chrono::Utc>>>("trigger_received_at"),
                    Some(row.get::<_, chrono::DateTime<chrono::Utc>>("queued_at")), "a drained send is received when it was queued");
                let (status, axum::Json(error)) = crate::multi_agent_plan::recover_lost_final_checkpoint(&state, last).await
                    .expect_err("the lead waits for the queued send's answer");
                assert_eq!(status, StatusCode::CONFLICT);
                assert_eq!(error.code.as_deref(), Some("dispatch_lane_busy"));
                // The answer ends as `/agent/complete` ends it: a goal-bound answer records its
                // wakeup in the same transaction.
                let mut db = pool.get().await?;
                let tx = db.transaction().await?;
                let answered_at: chrono::DateTime<chrono::Utc> = tx.query_one("update agent_jobs
                    set status='completed',outcome='succeeded',completed_at=now() where id=$1 returning completed_at",
                    &[&answer]).await?.get(0);
                crate::conversation_goals::state::settle_job(&tx, answer, &answer_payload, conversation, "succeeded").await
                    .map_err(|e| controller_error("queued answer goal settlement", e))?;
                tx.commit().await?;
                drop(db);
                if goal {
                    // The person's send took the goal over (`bind_dispatch` gave it a new
                    // revision), and its success wakes the goal at once, before the sweep's next
                    // tick: that turn waits for the team's lead instead of moving past it.
                    assert_eq!(answer_payload["metadata"]["_controllerGoal"]["userTurn"], json!(true));
                    assert_ne!(answer_payload["metadata"]["_controllerGoal"]["revision"], json!(revision.to_string()));
                    assert_eq!(wake_goal(&state, &pool, answer).await?, "pending", "the goal waits for the team's lead");
                }
                tick().await?;
                let finals = final_checkpoints(&pool, conversation, group).await?;
                assert_eq!(finals.len(), 1, "the lead follows the answer");
                assert!(finals[0].get::<_, chrono::DateTime<chrono::Utc>>("created_at") > answered_at, "after the answer");
                let payload = finals[0].get::<_, PgJson<serde_json::Value>>("payload").0;
                assert_eq!(payload["metadata"]["multiAgentPlan"]["triggerJobId"], json!(last));
                assert!(notices().await?.is_empty(), "no notice");
                assert!(!owes().await?, "the lead is queued");
                if goal {
                    // The lead does not carry the goal, which the answer's newer turn holds; the
                    // goal goes on from that answer once the summary has ended.
                    assert!(payload["metadata"].get("_controllerGoal").is_none(), "{payload}");
                    assert_eq!(wake_goal(&state, &pool, answer).await?, "pending", "the goal waits while the lead runs");
                    let lead: Uuid = finals[0].get("id");
                    let summarized_at: chrono::DateTime<chrono::Utc> = pool.get().await?.query_one("update agent_jobs
                        set status='completed',outcome='succeeded',completed_at=now() where id=$1 returning completed_at",
                        &[&lead]).await?.get(0);
                    assert_eq!(wake_goal(&state, &pool, answer).await?, "dispatched", "then the goal goes on");
                    let next = pool.get().await?.query("select created_at, payload from agent_jobs
                        where conversation_id=$1 and payload #>> '{metadata,goalContinuation,goalId}'=$2",
                        &[&conversation,&goal_id.to_string()]).await?;
                    assert_eq!(next.len(), 1);
                    assert!(next[0].get::<_, chrono::DateTime<chrono::Utc>>("created_at") > summarized_at, "after the summary");
                    assert_eq!(next[0].get::<_, PgJson<serde_json::Value>>("payload").0["metadata"]["_controllerGoal"]["revision"],
                        answer_payload["metadata"]["_controllerGoal"]["revision"], "from the answer's turn");
                    tick().await?;
                    assert!(notices().await?.is_empty(), "no notice after the summary");
                    assert_eq!(final_checkpoints(&pool, conversation, group).await?.len(), 1, "and no second lead");
                }
            }
            if goal {
                let metadata: serde_json::Value = pool.get().await?
                    .query_one("select metadata from conversations where id=$1", &[&conversation]).await?.get(0);
                let mut blocked_events = 0;
                loop {
                    match events.try_recv() {
                        Ok(event) => {
                            if event.kind == "conversation.updated" && event.conversation_id == Some(conversation)
                                && event.data["metadata"]["instafyGoal"]["status"] == json!("blocked") {
                                blocked_events += 1;
                            }
                        }
                        Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                        Err(error) => anyhow::bail!("reading goal events: {error}"),
                    }
                }
                let wakeups: i64 = pool.get().await?.query_one(
                    "select count(*) from conversation_goal_continuations where conversation_id=$1",
                    &[&conversation]).await?.get(0);
                assert_eq!(wakeups, i64::from(base == "queued"), "{case}: only the queued answer records a wakeup");
                match base {
                    "recovered" | "answered" => {
                        let lead: Uuid = finals[0].get("id");
                        let payload = finals[0].get::<_, PgJson<serde_json::Value>>("payload").0;
                        assert_eq!(payload["metadata"]["_controllerGoal"], json!({"revision":revision,
                            "ownerUserId":space.owner_user_id,"userTurn":false,"rootJobId":parent_job}),
                            "the lead carries the planning turn's goal");
                        assert_eq!(payload["metadata"]["goal"]["id"], json!(goal_id));
                        assert_eq!(metadata["instafyGoal"]["status"], json!("active"));
                        assert_eq!(blocked_events, 0);
                        // The lead's success wakes the goal's next turn, as a goal turn's does.
                        let mut db = pool.get().await?;
                        let tx = db.transaction().await?;
                        tx.execute("update agent_jobs set status='completed',outcome='succeeded',completed_at=now() where id=$1",
                            &[&lead]).await?;
                        crate::conversation_goals::state::settle_job(&tx, lead, &payload, conversation, "succeeded").await
                            .map_err(|e| controller_error("recovered lead goal settlement", e))?;
                        let pending: i64 = tx.query_one("select count(*) from conversation_goal_continuations
                            where source_job_id=$1 and goal_revision=$2 and status='pending'", &[&lead,&revision]).await?.get(0);
                        assert_eq!(pending, 1, "the recovered lead continues the goal");
                        tx.rollback().await?;
                    }
                    "given_up" => {
                        assert_eq!(metadata["instafyGoal"]["status"], json!("blocked"), "nothing else would continue it");
                        assert_eq!(metadata["instafyGoal"]["progressSummary"], json!(notice_text));
                        assert_eq!(metadata["instafyGoal"]["updatedBy"], json!(space.owner_user_id.to_string()));
                        assert_eq!(metadata["_goalController"]["revision"], json!(revision.to_string()), "the revision is kept");
                        assert_eq!(blocked_events, 1, "one conversation.updated carries the blocked goal");
                    }
                    "moved_on" => {
                        assert_eq!(metadata["instafyGoal"]["status"], json!("active"), "the newer turn carries the goal");
                        assert_eq!(metadata["_goalController"]["revision"], json!(owner_revision.to_string()));
                        assert_eq!(blocked_events, 0);
                    }
                    "queued" => {
                        assert_eq!(metadata["instafyGoal"]["status"], json!("active"), "the answer's turn carries the goal on");
                        assert_ne!(metadata["_goalController"]["revision"], json!(revision.to_string()));
                        assert_eq!(blocked_events, 0);
                    }
                    _ => unreachable!("{case}"),
                }
            }
            Ok(())
        }.await;
        let cleanup = space.cleanup().await;
        result.map_err(|error| error.context(case))?;
        cleanup?;
    }
    Ok(())
}

/// More groups can be owed a lead than one tick tries. Each tick takes the
/// newest, so groups that keep failing cannot crowd out new ones, and the
/// oldest, so no group waits untried until it is too old to report. Neither
/// takes a group still inside its settlement's grace.
#[tokio::test]
async fn a_tick_tries_the_newest_and_the_oldest_lost_final_leads() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping lost final lead window: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let _sweep = LOST_FINAL_LEAD_SWEEP.lock().await;
    let space = ManagedSpace::seed(pool.clone(), "lost-final-lead-window").await?;
    let result: anyhow::Result<()> = async {
        let state = build_test_state(pool.clone(), space.config("lost-final-lead-window"));
        // Five teams, each in its own conversation, whose workers ended 20, 15, 10 and 5
        // minutes ago, and 30 seconds ago, inside the grace.
        let mut teams = Vec::new();
        for ended_ago in [1200_i64, 900, 600, 300, 30] {
            let (group, parent_job) = (Uuid::new_v4(), Uuid::new_v4());
            let plan = json!({"groupId":group,"role":"worker","mode":"read_only",
                "parentJobId":parent_job,"parentRuntimeId":space.hosted_runtime_id,
                "lead":{"leadHandle":"octo","continuationPrompt":"Summarize the verified results."}});
            let (conversation, worker, _) =
                insert_finished_plan_lane(&space, None, "alpha", plan, json!({})).await?;
            let connection = pool.get().await?;
            connection.execute("insert into agent_jobs(id,project_id,conversation_id,status,outcome,created_at,trigger_received_at,completed_at,payload)
                values($1,$2,$3,'completed','succeeded',now()-($4::bigint*interval '1 second'),now()-($4::bigint*interval '1 second'),
                    now()-($5::bigint*interval '1 second'),'{}'::jsonb)",
                &[&parent_job,&space.project_id,&conversation,&(ended_ago+300),&(ended_ago+120)]).await?;
            connection.execute("update agent_jobs set agent_role='worker',plan_group_id=$2,parent_job_id=$3,
                created_at=now()-(($4::bigint+120)*interval '1 second'),trigger_received_at=now()-(($4::bigint+120)*interval '1 second'),
                completed_at=now()-($4::bigint*interval '1 second') where id=$1",
                &[&worker,&group,&parent_job,&ended_ago]).await?;
            teams.push((conversation, group));
        }
        // A tick tries every conversation's groups, so no other test's may be owed now.
        let mut others = crate::runtime::conversations_owing_a_lost_final_lead(&*pool.get().await?).await?;
        others.retain(|conversation| !teams.iter().any(|(team, _)| team == conversation));
        anyhow::ensure!(others.is_empty(), "other conversations owe a lost final lead, which a tick would try too: {others:?}");
        // A tick that tries the two newest groups and the oldest.
        let tick = || {
            let (state, pool) = (&state, &pool);
            async move {
                crate::runtime::recover_lost_final_plan_checkpoints_within(state, &mut TickConnection::new(pool), 2, 1).await
            }
        };
        let leads = || {
            let (pool, teams) = (&pool, &teams);
            async move {
                let mut leads = Vec::new();
                for (conversation, group) in teams {
                    leads.push(final_checkpoints(pool, *conversation, *group).await?.len());
                }
                Ok::<_, anyhow::Error>(leads)
            }
        };
        tick().await?;
        assert_eq!(leads().await?, vec![1, 0, 1, 1, 0], "the oldest and the two newest, past the grace");
        tick().await?;
        assert_eq!(leads().await?, vec![1, 1, 1, 1, 0], "then the one between");
        Ok(())
    }
    .await;
    let cleanup = space.cleanup().await;
    result?;
    cleanup?;
    Ok(())
}
