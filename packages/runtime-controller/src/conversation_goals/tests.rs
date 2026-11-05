use super::{claim_due, state};
use crate::tests::{require_origin_test_pool, with_empty_tables};
use serde_json::{json, Value};
use tokio_postgres::Transaction;
use uuid::Uuid;

struct GoalFixture {
    owner: Uuid,
    conversation: Uuid,
    job: Uuid,
    revision: Uuid,
    metadata: Value,
    payload: Value,
}

impl GoalFixture {
    async fn seed(tx: &Transaction<'_>) -> anyhow::Result<Self> {
        let owner = Uuid::new_v4();
        let project = Uuid::new_v4();
        let conversation = Uuid::new_v4();
        let prompt = Uuid::new_v4();
        let run = Uuid::new_v4();
        let job = Uuid::new_v4();
        let revision = Uuid::new_v4();
        let metadata = json!({
            "instafyGoal": {"id": Uuid::new_v4(), "objective": "Verify the workspace change", "status": "active"},
            "_goalController": {"revision": revision, "ownerUserId": owner}
        });
        let payload = json!({
            "project_id": project, "conversation_id": conversation,
            "metadata": {"_controllerGoal": {"revision": revision, "ownerUserId": owner}}
        });
        // All rows, including the auth user, belong to the caller's transaction.
        tx.execute("insert into auth.users(id) values($1)", &[&owner])
            .await?;
        tx.execute(
            "insert into projects(id,owner_user_id,project_type,status) values($1,$2,'customer','active')",
            &[&project, &owner],
        ).await?;
        tx.execute(
            "insert into conversations(id,project_id,created_by,metadata,visibility) values($1,$2,$3,$4,'private')",
            &[&conversation, &project, &owner, &metadata],
        ).await?;
        tx.execute(
            "insert into prompts(id,project_id,conversation_id,user_id,prompt_text) values($1,$2,$3,$4,'Continue the goal')",
            &[&prompt, &project, &conversation, &owner],
        ).await?;
        tx.execute(
            "insert into runs(id,project_id,conversation_id,prompt_id,run_type,status) values($1,$2,$3,$4,'prompt','in_progress')",
            &[&run, &project, &conversation, &prompt],
        ).await?;
        tx.execute(
            "insert into agent_jobs(id,project_id,conversation_id,prompt_id,run_id,status,payload) values($1,$2,$3,$4,$5,'leased',$6)",
            &[&job, &project, &conversation, &prompt, &run, &payload],
        ).await?;
        Ok(Self {
            owner,
            conversation,
            job,
            revision,
            metadata,
            payload,
        })
    }

    async fn metadata(&self, tx: &Transaction<'_>) -> anyhow::Result<Value> {
        Ok(tx
            .query_one(
                "select metadata from conversations where id=$1",
                &[&self.conversation],
            )
            .await?
            .get(0))
    }

    async fn wakeups(&self, tx: &Transaction<'_>) -> anyhow::Result<i64> {
        Ok(tx
            .query_one(
                "select count(*) from conversation_goal_continuations where source_job_id=$1",
                &[&self.job],
            )
            .await?
            .get(0))
    }

    async fn complete(&self, tx: &Transaction<'_>) -> anyhow::Result<()> {
        tx.execute(
            "update agent_jobs set status='completed',outcome='succeeded' where id=$1",
            &[&self.job],
        )
        .await?;
        state::settle_job(tx, self.job, &self.payload, self.conversation, "succeeded")
            .await
            .map_err(api_error)?;
        Ok(())
    }
}

fn api_error(error: (axum::http::StatusCode, axum::Json<crate::ApiError>)) -> anyhow::Error {
    anyhow::anyhow!("{}: {}", error.0, error.1 .0.message)
}

#[test]
fn client_goal_callbacks_cannot_claim_controller_authority_but_manual_resume_is_allowed() {
    for key in ["goalContinuation", "goal_continuation"] {
        let mut callback = json!({
            key: {"triggerRunId": Uuid::new_v4(), "source": "controller", "turn": 1},
            "_controllerGoal": {"revision": Uuid::new_v4(), "ownerUserId": Uuid::new_v4(), "userTurn": true}
        });
        super::strip_job_claims(&mut callback);
        assert!(callback.get("_controllerGoal").is_none());
        assert!(super::is_legacy_automatic_continuation(&callback));
        assert!(!super::is_legacy_automatic_continuation(&json!({
            key: {"source": "manual_resume", "turn": 2}
        })));
    }
}

#[tokio::test]
async fn stale_goal_revision_cannot_undo_client_pause_clear_or_replacement() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("stale goal revision").await?;
    for edit in ["pause", "clear", "replace"] {
        let mut db = pool.get().await?;
        let tx = db.transaction().await?;
        let mut fixture = GoalFixture::seed(&tx).await?;
        fixture.payload["metadata"]["_controllerGoal"]["userTurn"] = json!(true);
        tx.execute(
            "update agent_jobs set payload=$2 where id=$1",
            &[&fixture.job, &fixture.payload],
        )
        .await?;
        let mut metadata = fixture.metadata.clone();
        match edit {
            "pause" => metadata["instafyGoal"]["status"] = json!("paused"),
            "clear" => metadata["instafyGoal"] = Value::Null,
            _ => {
                metadata["instafyGoal"] = json!({"id": Uuid::new_v4(), "objective": "A different goal", "status": "active"})
            }
        }
        state::prepare_client_metadata(&mut metadata);
        state::preserve_unchanged_goal_revision(&mut metadata, Some(&fixture.metadata));
        assert_ne!(
            metadata["_goalController"]["revision"],
            json!(fixture.revision)
        );
        tx.execute(
            "update conversations set metadata=$2 where id=$1",
            &[&fixture.conversation, &metadata],
        )
        .await?;
        let changed = state::apply_runtime_update(
            &tx,
            fixture.job,
            &fixture.payload,
            fixture.conversation,
            &json!({"details": {"status": "active", "objective": "Late runtime update"}}),
            "Still working",
        )
        .await
        .map_err(api_error)?;
        assert!(changed.is_none(), "{edit} must fence a late goal update");
        fixture.complete(&tx).await?;
        assert_eq!(fixture.metadata(&tx).await?, metadata, "{edit}");
        assert_eq!(fixture.wakeups(&tx).await?, 0, "{edit}");
        tx.rollback().await?;
    }
    Ok(())
}

#[tokio::test]
async fn only_a_fresh_authoritative_user_turn_can_resume_or_clear_an_inactive_goal(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("human goal resume authority").await?;
    for clear in [false, true] {
        let mut db = pool.get().await?;
        let tx = db.transaction().await?;
        let mut fixture = GoalFixture::seed(&tx).await?;
        fixture.metadata["instafyGoal"]["status"] = json!("paused");
        tx.execute(
            "update conversations set metadata=$2 where id=$1",
            &[&fixture.conversation, &fixture.metadata],
        )
        .await?;
        let update = if clear {
            json!({"details":{"operation":"clear"}})
        } else {
            json!({"details":{"status":"active"}})
        };
        assert!(state::apply_runtime_update(
            &tx,
            fixture.job,
            &fixture.payload,
            fixture.conversation,
            &update,
            ""
        )
        .await
        .map_err(api_error)?
        .is_none());
        // A caller-supplied flag is not authority unless dispatch persisted it.
        fixture.payload["metadata"]["_controllerGoal"]["userTurn"] = json!(true);
        assert!(state::apply_runtime_update(
            &tx,
            fixture.job,
            &fixture.payload,
            fixture.conversation,
            &update,
            ""
        )
        .await
        .map_err(api_error)?
        .is_none());
        fixture.revision = Uuid::new_v4();
        fixture.payload["metadata"]["_controllerGoal"]["revision"] = json!(fixture.revision);
        fixture.metadata["_goalController"]["revision"] = json!(fixture.revision);
        tx.execute(
            "update agent_jobs set payload=$2 where id=$1",
            &[&fixture.job, &fixture.payload],
        )
        .await?;
        tx.execute(
            "update conversations set metadata=$2 where id=$1",
            &[&fixture.conversation, &fixture.metadata],
        )
        .await?;
        assert!(state::apply_runtime_update(
            &tx,
            fixture.job,
            &fixture.payload,
            fixture.conversation,
            &update,
            ""
        )
        .await
        .map_err(api_error)?
        .is_some());
        let metadata = fixture.metadata(&tx).await?;
        if clear {
            assert!(metadata["instafyGoal"].is_null());
        } else {
            assert_eq!(metadata["instafyGoal"]["status"], "active");
        }
        tx.rollback().await?;
    }
    Ok(())
}

#[tokio::test]
async fn unchanged_client_goal_snapshot_preserves_the_running_jobs_binding() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("unchanged goal snapshot").await?;
    let mut db = pool.get().await?;
    let tx = db.transaction().await?;
    let fixture = GoalFixture::seed(&tx).await?;
    let mut patch =
        json!({"instafyGoal": fixture.metadata["instafyGoal"], "title": "Updated chat title"});
    state::prepare_client_metadata(&mut patch);
    state::preserve_unchanged_goal_revision(&mut patch, Some(&fixture.metadata));
    tx.execute(
        "update conversations set metadata=metadata||$2::jsonb where id=$1",
        &[&fixture.conversation, &patch],
    )
    .await?;
    assert!(
        state::apply_runtime_update(
            &tx,
            fixture.job,
            &fixture.payload,
            fixture.conversation,
            &json!({"details":{"progressSummary":"The workspace check passed"}}),
            "",
        )
        .await
        .map_err(api_error)?
        .is_some(),
        "saving an unchanged snapshot must not orphan the running job"
    );
    fixture.complete(&tx).await?;
    let metadata = fixture.metadata(&tx).await?;
    assert_eq!(
        metadata["_goalController"]["revision"],
        json!(fixture.revision)
    );
    assert_eq!(
        metadata["instafyGoal"]["progressSummary"],
        "The workspace check passed"
    );
    assert_eq!(fixture.wakeups(&tx).await?, 1);
    tx.rollback().await?;
    Ok(())
}

#[tokio::test]
async fn workers_and_early_checkpoints_cannot_update_or_continue_the_parent_goal(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("worker goal isolation").await?;
    for plan in [
        json!({"role": "worker"}),
        json!({"role": "lead_continuation", "checkpointKind": "early_failure"}),
    ] {
        let mut db = pool.get().await?;
        let tx = db.transaction().await?;
        let mut fixture = GoalFixture::seed(&tx).await?;
        fixture.payload["metadata"]["multiAgentPlan"] = plan;
        tx.execute(
            "update agent_jobs set payload=$2 where id=$1",
            &[&fixture.job, &fixture.payload],
        )
        .await?;
        assert!(state::apply_runtime_update(
            &tx,
            fixture.job,
            &fixture.payload,
            fixture.conversation,
            &json!({"details": {"status": "completed"}}),
            "Worker finished",
        )
        .await
        .map_err(api_error)?
        .is_none());
        fixture.complete(&tx).await?;
        assert_eq!(fixture.metadata(&tx).await?, fixture.metadata);
        assert_eq!(fixture.wakeups(&tx).await?, 0);
        tx.rollback().await?;
    }
    Ok(())
}

#[tokio::test]
async fn goal_binding_uses_authoritative_prompt_owner_and_conversation() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("goal owner binding").await?;
    let mut db = pool.get().await?;
    let tx = db.transaction().await?;
    let mut fixture = GoalFixture::seed(&tx).await?;
    let unrelated = GoalFixture::seed(&tx).await?;
    assert!(state::apply_runtime_update(
        &tx,
        fixture.job,
        &fixture.payload,
        unrelated.conversation,
        &json!({"details": {"status": "completed"}}),
        "Wrong conversation",
    )
    .await
    .map_err(api_error)?
    .is_none());
    // Even consistent payload and goal metadata cannot replace the prompt's real owner.
    fixture.payload["metadata"]["_controllerGoal"]["ownerUserId"] = json!(unrelated.owner);
    fixture.metadata["_goalController"]["ownerUserId"] = json!(unrelated.owner);
    tx.execute(
        "update agent_jobs set payload=$2 where id=$1",
        &[&fixture.job, &fixture.payload],
    )
    .await?;
    tx.execute(
        "update conversations set metadata=$2 where id=$1",
        &[&fixture.conversation, &fixture.metadata],
    )
    .await?;
    assert!(state::apply_runtime_update(
        &tx,
        fixture.job,
        &fixture.payload,
        fixture.conversation,
        &json!({"details": {"status": "completed"}}),
        "Wrong owner",
    )
    .await
    .map_err(api_error)?
    .is_none());
    fixture.complete(&tx).await?;
    assert_eq!(fixture.metadata(&tx).await?, fixture.metadata);
    assert_eq!(unrelated.metadata(&tx).await?, unrelated.metadata);
    assert_eq!(fixture.wakeups(&tx).await?, 0);
    tx.rollback().await?;
    Ok(())
}

#[tokio::test]
async fn final_lead_completion_records_one_durable_continuation() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("durable goal completion").await?;
    let mut db = pool.get().await?;
    let tx = db.transaction().await?;
    let mut fixture = GoalFixture::seed(&tx).await?;
    fixture.payload["metadata"]["multiAgentPlan"] =
        json!({"role": "lead_continuation", "checkpointKind": "final"});
    tx.execute(
        "update agent_jobs set payload=$2 where id=$1",
        &[&fixture.job, &fixture.payload],
    )
    .await?;
    // An early call while still leased is not a terminal completion.
    state::settle_job(
        &tx,
        fixture.job,
        &fixture.payload,
        fixture.conversation,
        "succeeded",
    )
    .await
    .map_err(api_error)?;
    assert_eq!(fixture.wakeups(&tx).await?, 0);
    tx.execute(
        "update agent_jobs set planning_receipt_state='{}' where id=$1",
        &[&fixture.job],
    )
    .await?;
    fixture.complete(&tx).await?;
    assert_eq!(
        fixture.wakeups(&tx).await?,
        0,
        "a planning receipt waits for its team's final result"
    );
    tx.execute(
        "update agent_jobs set planning_receipt_state=null where id=$1",
        &[&fixture.job],
    )
    .await?;
    fixture.complete(&tx).await?;
    fixture.complete(&tx).await?;
    let rows = tx.query("select conversation_id,goal_revision,owner_user_id,status from conversation_goal_continuations where source_job_id=$1", &[&fixture.job]).await?;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].get::<_, Uuid>("conversation_id"),
        fixture.conversation
    );
    assert_eq!(rows[0].get::<_, Uuid>("goal_revision"), fixture.revision);
    assert_eq!(rows[0].get::<_, Uuid>("owner_user_id"), fixture.owner);
    assert_eq!(rows[0].get::<_, String>("status"), "pending");
    tx.rollback().await?;
    Ok(())
}

#[tokio::test]
async fn terminal_runtime_goal_update_prevents_completion_wakeup() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("terminal goal update").await?;
    for status in ["completed", "blocked", "canceled", "paused"] {
        let mut db = pool.get().await?;
        let tx = db.transaction().await?;
        let fixture = GoalFixture::seed(&tx).await?;
        assert!(state::apply_runtime_update(
            &tx,
            fixture.job,
            &fixture.payload,
            fixture.conversation,
            &json!({"details": {"status": status}}),
            "Current evidence",
        )
        .await
        .map_err(api_error)?
        .is_some());
        fixture.complete(&tx).await?;
        assert_eq!(
            fixture.metadata(&tx).await?["instafyGoal"]["status"],
            status
        );
        assert_eq!(fixture.wakeups(&tx).await?, 0);
        tx.rollback().await?;
    }
    Ok(())
}

#[tokio::test]
async fn failed_or_canceled_job_stops_an_active_goal() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("failed goal completion").await?;
    for (outcome, job_status, status) in [
        ("failed", "failed", "blocked"),
        ("canceled", "canceled", "canceled"),
        ("expired", "failed", "canceled"),
    ] {
        let mut db = pool.get().await?;
        let tx = db.transaction().await?;
        let fixture = GoalFixture::seed(&tx).await?;
        tx.execute(
            "update agent_jobs set status=$2 where id=$1",
            &[&fixture.job, &job_status],
        )
        .await?;
        if outcome == "failed" {
            tx.execute(
                "update agent_jobs set planning_receipt_state='{}' where id=$1",
                &[&fixture.job],
            )
            .await?;
        }
        assert!(state::settle_job(
            &tx,
            fixture.job,
            &fixture.payload,
            fixture.conversation,
            outcome
        )
        .await
        .map_err(api_error)?
        .is_some());
        let metadata = fixture.metadata(&tx).await?;
        assert_eq!(metadata["instafyGoal"]["status"], status);
        assert!(metadata["instafyGoal"]["progressSummary"]
            .as_str()
            .unwrap()
            .contains(outcome));
        assert_eq!(fixture.wakeups(&tx).await?, 0);
        tx.rollback().await?;
    }
    Ok(())
}

#[tokio::test]
async fn goal_admission_waits_for_worker_questions_and_rejects_a_replaced_goal(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("goal admission fences").await?;
    let mut db = pool.get().await?;
    let tx = db.transaction().await?;
    let fixture = GoalFixture::seed(&tx).await?;
    fixture.complete(&tx).await?;
    let project: Uuid = tx
        .query_one(
            "select project_id from conversations where id=$1",
            &[&fixture.conversation],
        )
        .await?
        .get(0);
    tx.execute(
        "insert into agent_user_input_requests(project_id,conversation_id,job_id,lease_attempt,group_id,agent_handle,questions,continuation_note) values($1,$2,$3,0,$4,'helper','[]','Continue after the answer')",
        &[&project,&fixture.conversation,&fixture.job,&Uuid::new_v4()],
    ).await?;
    for status in ["pending", "answered"] {
        tx.execute(
            "update agent_user_input_requests set status=$2 where job_id=$1",
            &[&fixture.job, &status],
        )
        .await?;
        let error = super::ensure_idle(&tx, fixture.conversation, fixture.job)
            .await
            .expect_err("an unresolved worker question blocks goal dispatch");
        assert_eq!(error.0, axum::http::StatusCode::CONFLICT, "{status}");
    }
    tx.execute(
        "update agent_user_input_requests set status='resumed' where job_id=$1",
        &[&fixture.job],
    )
    .await?;
    super::ensure_idle(&tx, fixture.conversation, fixture.job)
        .await
        .map_err(api_error)?;

    let token = Uuid::new_v4();
    tx.execute("update conversation_goal_continuations set status='claimed',claim_token=$2,locked_until=now()+interval '5 minutes' where source_job_id=$1", &[&fixture.job,&token]).await?;
    let mut replacement = json!({"instafyGoal":{"id":Uuid::new_v4(),"objective":"The user's new goal","status":"active"}});
    state::prepare_client_metadata(&mut replacement);
    tx.execute(
        "update conversations set metadata=$2 where id=$1",
        &[&fixture.conversation, &replacement],
    )
    .await?;
    let conversation = crate::conversations::load_conversation_record(&tx, &fixture.conversation)
        .await
        .map_err(api_error)?;
    let mut request=crate::dispatch::normalize_dispatch_request(serde_json::from_value(json!({"projectId":project,"conversationId":fixture.conversation,"promptText":"Stale prepared continuation"}))?).map_err(api_error)?;
    request.goal_wakeup = Some((fixture.job, token));
    let context = crate::auth::RequestContext {
        user_id: Some(fixture.owner),
        is_service_role: false,
        scoped_claims: None,
    };
    let error = super::bind_dispatch(&tx, &context, &conversation, &mut request)
        .await
        .expect_err("a saved request must recheck the current goal at admission");
    assert_eq!(error.0, axum::http::StatusCode::CONFLICT);
    assert_eq!(fixture.metadata(&tx).await?, replacement);
    tx.rollback().await?;
    Ok(())
}

#[tokio::test]
async fn durable_goal_claim_is_exclusive_and_reclaims_an_expired_lease() -> anyhow::Result<()> {
    // Isolating the ledger makes the global claim query independent of other tests.
    with_empty_tables(&["conversation_goal_continuations"], |pool| async move {
        let source = Uuid::new_v4();
        let conversation = Uuid::new_v4();
        let revision = Uuid::new_v4();
        let owner = Uuid::new_v4();
        pool.get().await?.execute(
            "insert into conversation_goal_continuations(source_job_id,conversation_id,goal_revision,owner_user_id) values($1,$2,$3,$4)",
            &[&source, &conversation, &revision, &owner],
        ).await?;
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));
        let claim = || {
            let pool = pool.clone();
            let barrier = barrier.clone();
            async move {
                let mut db = pool.get().await?;
                let tx = db.transaction().await?;
                tx.batch_execute("set local lock_timeout='5s'").await?;
                barrier.wait().await;
                let wakeup = claim_due(&tx).await.map_err(|e| anyhow::anyhow!("{e:?}"))?;
                tx.commit().await?;
                Ok::<_, anyhow::Error>(wakeup)
            }
        };
        let (a, b) = tokio::join!(claim(), claim());
        let claims: Vec<_> = [a?, b?].into_iter().flatten().collect();
        assert_eq!(claims.len(), 1, "only one scheduler can own this wakeup");
        let initial = &claims[0];
        assert_eq!(initial.source_job_id, source);
        assert_eq!(initial.attempts, 0);
        let mut db = pool.get().await?;
        let tx = db.transaction().await?;
        assert!(claim_due(&tx).await.map_err(|e| anyhow::anyhow!("{e:?}"))?.is_none());
        // Simulate a crashed scheduler's expired lease without wall-clock sleeping.
        tx.execute("update conversation_goal_continuations set locked_until=now()-interval '1 second' where source_job_id=$1", &[&source]).await?;
        let reclaimed = claim_due(&tx).await.map_err(|e| anyhow::anyhow!("{e:?}"))?.expect("expired claim is recoverable");
        assert_eq!(reclaimed.source_job_id, source);
        assert_eq!(reclaimed.attempts, 0, "crash recovery does not spend the dispatch failure budget");
        assert_ne!(reclaimed.claim_token, initial.claim_token);
        tx.execute("update conversation_goal_continuations set status='dispatched' where source_job_id=$1", &[&source]).await?;
        assert!(claim_due(&tx).await.map_err(|e| anyhow::anyhow!("{e:?}"))?.is_none());
        tx.commit().await?;
        Ok(())
    }).await
}

#[tokio::test]
async fn goal_scheduler_dispatches_once_across_crashes_before_and_after_dispatch(
) -> anyhow::Result<()> {
    use crate::dispatch::{normalize_dispatch_request, process_dispatch_prompt};
    use crate::tests::{
        build_app_config, build_test_state, ensure_test_user, test_origin_private_key,
        test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
    };
    use futures_util::FutureExt;

    let pool = require_origin_test_pool("goal dispatch recovery").await?;
    let owner = Uuid::new_v4();
    let replacement_owner = Uuid::new_v4();
    let org = Uuid::new_v4();
    let project = Uuid::new_v4();
    let conversation = Uuid::new_v4();
    ensure_test_user(&pool, &owner).await?;
    ensure_test_user(&pool, &replacement_owner).await?;
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "goal-dispatch",
    );
    config.managed_ai_enabled = false;
    let app = build_test_state(pool.clone(), config);
    let outcome = std::panic::AssertUnwindSafe(with_shared_db_fixture(
        SharedDbFixture { organizations: vec![org], projects: vec![project] },
        async {
            {
                let mut db = pool.get().await?;
                let tx = db.transaction().await?;
                tx.execute("insert into organizations(id,slug,name) values($1,$2,'Goal tests')", &[&org, &format!("goal-{org}")]).await?;
                tx.execute("insert into org_memberships(org_id,user_id,role) values($1,$2,'owner')", &[&org, &owner]).await?;
                tx.execute("insert into projects(id,org_id,owner_user_id,project_type,status) values($1,$2,$3,'customer','active')", &[&project, &org, &owner]).await?;
                tx.execute("insert into conversations(id,project_id,created_by,visibility,metadata) values($1,$2,$3,'private','{}')", &[&conversation, &project, &owner]).await?;
                // Dispatch only checks ownership/selection. This inert credential is never
                // decrypted and the test provider is noop, so no model request can occur.
                tx.execute("insert into user_credentials(id,user_id,kind,label,nonce_b64,ciphertext_b64,metadata,is_default) values($1,$2,'openai_api_key','Fixture','fixture','fixture','{}',true)", &[&Uuid::new_v4(), &owner]).await?;
                tx.commit().await?;
            }
            let context = crate::auth::RequestContext {user_id:Some(owner),is_service_role:false,scoped_claims:None};
            let request = normalize_dispatch_request(serde_json::from_value(json!({
                "projectId": project, "conversationId": conversation,
                "promptText": "Check the release checklist and continue until verified", "intent":"feature",
                "metadata":{"clientMessageId":Uuid::new_v4(),"agentSelection":{"active":["octo"],"mentions":["octo"]},"writeScope":{"mode":"read_only"}}
            }))?).map_err(api_error)?;
            let response = process_dispatch_prompt(&app, &context, request).await.map_err(api_error)?;
            let source = response.job_id.ok_or_else(||anyhow::anyhow!("initial goal dispatch queued no job: {}",response.status))?;
            let wake = {
                let mut db = pool.get().await?;
                let tx = db.transaction().await?;
                let row = tx.query_one("update agent_jobs set status='leased' where id=$1 returning payload,run_id", &[&source]).await?;
                assert!(state::apply_runtime_update(&tx,source,&row.get::<_,Value>("payload"),conversation,&json!({"details":{"objective":"Verify the release checklist","status":"active"}}),"Checklist loaded").await.map_err(api_error)?.is_some());
                tx.execute("update agent_jobs set status='completed',outcome='succeeded',completed_at=now() where id=$1", &[&source]).await?;
                let run:Uuid = row.get("run_id");
                tx.execute("update runs set status='success' where id=$1", &[&run]).await?;
                state::settle_job(&tx,source,&row.get::<_,Value>("payload"),conversation,"succeeded").await.map_err(api_error)?;
                let wake = claim_due(&tx).await.map_err(api_error)?.expect("completed active goal has a wakeup");
                assert_eq!(wake.source_job_id, source);
                tx.commit().await?;
                wake
            };
            let saved_request=super::prepare_request(&app,&wake).await.map_err(api_error)?.expect("active goal prepares a continuation");
            assert_eq!(saved_request["metadata"]["agentSelection"]["active"],json!(["octo"]));
            assert_eq!(saved_request["metadata"]["writeScope"]["mode"],"read_only");
            let replay = {
                let mut db = pool.get().await?;
                let tx = db.transaction().await?;
                // The request committed, then the scheduler crashed before dispatch.
                tx.execute("update conversation_goal_continuations set locked_until=now()-interval '1 second' where source_job_id=$1", &[&source]).await?;
                let wake=claim_due(&tx).await.map_err(api_error)?.expect("recovery claims the expired lease");
                tx.commit().await?;
                wake
            };
            super::process_wakeup(&app,&wake).await.map_err(api_error)?;
            let count:i64=pool.get().await?.query_one("select count(*) from agent_jobs where conversation_id=$1 and id<>$2", &[&conversation,&source]).await?.get(0);
            assert_eq!(count,0,"the stale scheduler cannot dispatch after its lease was reclaimed");
            super::process_wakeup(&app,&replay).await.map_err(api_error)?;
            let first = pool.get().await?.query_one("select status,run_id from conversation_goal_continuations where source_job_id=$1", &[&source]).await?;
            assert_eq!(first.get::<_,String>("status"),"dispatched");
            let successor_run:Uuid=first.get("run_id");
            // A crash after dispatch cannot leave an unacknowledged wakeup: the
            // successor and ledger acknowledgement commit together. Replay is inert.
            super::process_wakeup(&app,&replay).await.map_err(api_error)?;
            let db=pool.get().await?;
            let recovered=db.query_one("select status,run_id,request from conversation_goal_continuations where source_job_id=$1", &[&source]).await?;
            assert_eq!(recovered.get::<_,String>("status"),"dispatched");
            assert_eq!(recovered.get::<_,Uuid>("run_id"),successor_run);
            assert_eq!(recovered.get::<_,Value>("request"),saved_request);
            let jobs=db.query("select id,status,payload from agent_jobs where conversation_id=$1 and id<>$2", &[&conversation,&source]).await?;
            assert_eq!(jobs.len(),1,"recovery must not queue duplicate work");
            assert_eq!(jobs[0].get::<_,String>("status"),"queued");
            let payload:Value=jobs[0].get("payload");
            assert_eq!(payload["metadata"]["_controllerGoal"]["revision"],json!(wake.goal_revision));
            assert_eq!(payload["metadata"]["goalContinuation"]["turn"],1);
            let successor:Uuid=jobs[0].get("id");
            drop(db);

            // Membership can change between turns. A durable wakeup is not a
            // stored permission grant and cannot bypass ordinary dispatch access.
            let denied={
                let mut db=pool.get().await?;
                let tx=db.transaction().await?;
                tx.execute("update agent_jobs set status='completed',outcome='succeeded',completed_at=now() where id=$1", &[&successor]).await?;
                tx.execute("update runs set status='success' where id=$1", &[&successor_run]).await?;
                state::settle_job(&tx,successor,&payload,conversation,"succeeded").await.map_err(api_error)?;
                let wake=claim_due(&tx).await.map_err(api_error)?.expect("successor completion creates the next wakeup");
                assert_eq!(wake.source_job_id,successor);
                tx.execute("delete from project_memberships where project_id=$1 and user_id=$2", &[&project,&owner]).await?;
                tx.execute("delete from org_memberships where org_id=$1 and user_id=$2", &[&org,&owner]).await?;
                tx.execute("update projects set owner_user_id=$2 where id=$1", &[&project,&replacement_owner]).await?;
                tx.commit().await?;
                wake
            };
            super::process_wakeup(&app,&denied).await.map_err(api_error)?;
            let db=pool.get().await?;
            assert_eq!(db.query_one("select status from conversation_goal_continuations where source_job_id=$1", &[&successor]).await?.get::<_,String>(0),"blocked");
            assert_eq!(db.query_one("select metadata#>>'{instafyGoal,status}' from conversations where id=$1", &[&conversation]).await?.get::<_,String>(0),"blocked");
            assert_eq!(db.query_one("select count(*) from agent_jobs where conversation_id=$1", &[&conversation]).await?.get::<_,i64>(0),2,"revoked access must not queue another job");
            Ok(())
        },
    )).catch_unwind().await;
    pool.get()
        .await?
        .execute(
            "delete from auth.users where id=any($1)",
            &[&vec![owner, replacement_owner]],
        )
        .await?;
    match outcome {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
