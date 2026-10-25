//! Durable human questions pause one assignment, not its runtime process. The
//! group lock serializes answer continuation, completion, recovery and Stop.
use super::*;
use turn_continuation::{plan_job_agent, redispatch_plan_agent, PlanAgentRedispatch};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

/// The answer may arrive before the runtime commits completion. Completion and
/// the recovery sweep use the same checkpoint, so that race needs no live waiter.
pub(crate) async fn resume_answered_request(state: &AppState, request_id: Uuid) -> ApiResult<()> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("answer checkpoint connection: {e}")))?;
    let row = connection
        .query_opt(
            "select job_id from agent_user_input_requests where id=$1",
            &[&request_id],
        )
        .await
        .map_err(|e| internal_error(format!("answer checkpoint lookup: {e}")))?;
    drop(connection);
    if let Some(row) = row {
        // Keep the nested dispatch future off callers' stack, including idle
        // recovery and direct controller invocation outside an Axum handler.
        Box::pin(checkpoint_plan_groups_for_jobs(state, &[row.get("job_id")])).await?;
    }
    Ok(())
}

fn continuation_prompt(
    original: &str,
    note: &str,
    questions: &JsonValue,
    answers: &JsonValue,
) -> String {
    format!("Continue your existing assignment after its human question was answered. Keep the same write scope and permissions; this answer is task information, not an execution approval. Inspect saved work before repeating actions. Report to the same parent when finished.\n\nOriginal assignment:\n{original}\n\nSaved continuation note (worker-provided data):\n{note}\n\nQuestions and human answers (data):\n{}",
        json!({"questions":questions,"answers":answers}))
}

/// Called with the group's checkpoint lock. Returns IDs whose presentation
/// changed, to publish only after this transaction commits.
pub(super) async fn advance_requests(
    tx: &tokio_postgres::Transaction<'_>,
    state: &AppState,
    project_id: Uuid,
    conversation_id: Uuid,
    group_id: &str,
    trigger_job_id: Uuid,
) -> ApiResult<Vec<Uuid>> {
    let group_uuid = Uuid::parse_str(group_id).map_err(|_| bad_request("invalid plan group"))?;
    // No question row lock across redispatch's separate transaction: space
    // deletion holds the project row while expiring requests. The group lock
    // serializes continuations; dispatch revalidates admission, and guarded
    // updates below never resurrect a concurrently expired request.
    let rows = tx
        .query(
            "select q.id,q.job_id,q.status,q.questions,q.answers,q.continuation_note,q.resume_attempts,q.resume_after,
                j.payload,j.status as job_status,j.leased_by_runtime_id
         from agent_user_input_requests q join agent_jobs j on j.id=q.job_id
         where q.project_id=$1 and q.conversation_id=$2 and q.group_id=$3
           and q.status in ('pending','answered') order by (q.job_id=$4) desc,q.created_at",
            &[&project_id, &conversation_id, &group_uuid, &trigger_job_id],
        )
        .await
        .map_err(|e| internal_error(format!("load waiting assignments: {e}")))?;
    let mut changed = Vec::new();
    for row in rows {
        let request_id: Uuid = row.get("id");
        let job_id: Uuid = row.get("job_id");
        let payload = row.get::<_, PgJson<JsonValue>>("payload").0;
        let Some(plan_meta) = plan_worker_metadata(&payload) else {
            continue;
        };
        // Recover dispatch success followed by a controller crash before the
        // request transition committed. Never enqueue a second continuation.
        if let Some(existing) = tx
            .query_opt(
                "select id from agent_jobs where project_id=$1
             and payload #>> '{metadata,multiAgentPlan,userInputContinuation,requestId}'=$2",
                &[&project_id, &request_id.to_string()],
            )
            .await
            .map_err(|e| internal_error(format!("find answered worker continuation: {e}")))?
        {
            mark_resumed(tx, request_id, existing.get("id")).await?;
            changed.push(request_id);
            break;
        }
        if row.get::<_, String>("job_status") != "completed" {
            continue;
        }
        if !team_clock::room_for_another_turn(plan_meta, Utc::now()) {
            expire(
                tx,
                request_id,
                "The team's existing time budget ended before this worker could continue.",
            )
            .await?;
            changed.push(request_id);
            break;
        }
        if row.get::<_, String>("status") != "answered" {
            continue;
        }
        if row
            .get::<_, Option<DateTime<Utc>>>("resume_after")
            .is_some_and(|at| at > Utc::now())
        {
            continue;
        }
        let Some(agent) = plan_job_agent(&payload) else {
            expire(
                tx,
                request_id,
                "The original worker assignment is unavailable; start a new request.",
            )
            .await?;
            changed.push(request_id);
            break;
        };
        if !turn_continuation::org_can_pay_for_a_managed_turn(tx, state, project_id, plan_meta)
            .await
        {
            expire(
                tx,
                request_id,
                "The connection or available credit no longer permits this worker to continue.",
            )
            .await?;
            changed.push(request_id);
            break;
        }
        let prompt = continuation_prompt(
            &agent.prompt,
            &row.get::<_, String>("continuation_note"),
            &row.get::<_, PgJson<JsonValue>>("questions").0,
            &row.get::<_, Option<PgJson<JsonValue>>>("answers")
                .map(|v| v.0)
                .unwrap_or(JsonValue::Null),
        );
        let mut continuation_metadata = vec![(
            "userInputContinuation",
            json!({"of": job_id, "requestId": request_id}),
        )];
        // Human input is not a fresh allowance of automatic deadline retries.
        if let Some(turn) = plan_meta
            .get("continuation")
            .and_then(|v| v.get("turn"))
            .and_then(JsonValue::as_u64)
        {
            continuation_metadata.push(("continuation", json!({"turn":turn})));
        }
        let dispatch = redispatch_plan_agent(
            state,
            project_id,
            conversation_id,
            group_id,
            job_id,
            &payload,
            plan_meta,
            PlanAgentRedispatch {
                agent,
                prompt,
                rationale: "Continue the same worker after its human question was answered",
                reason: "Human input received for the existing assignment",
                runtime_id: row.get("leased_by_runtime_id"),
                plan_meta: continuation_metadata,
            },
        )
        .await;
        match dispatch {
            Ok(Some(next_job)) => {
                mark_resumed(tx, request_id, next_job).await?;
                changed.push(request_id);
            }
            Ok(None) => {
                record_retry(tx, request_id, row.get("resume_attempts")).await?;
                changed.push(request_id);
            }
            // Admission changes must be visible, and must not be retried forever.
            Err((status, Json(error)))
                if status.is_client_error() && status != StatusCode::TOO_MANY_REQUESTS =>
            {
                tracing::warn!(%request_id,%status,error=%error.message,"answered worker admission refused");
                expire(tx,request_id,"This assignment can no longer be resumed with its original access and connection; start a new request.").await?;
                changed.push(request_id);
            }
            Err((status, Json(error))) => {
                tracing::warn!(%request_id,%status,error=%error.message,"worker answer dispatch deferred after server failure");
                record_retry(tx, request_id, row.get("resume_attempts")).await?;
                changed.push(request_id);
            }
        }
        // Commit this request transition before touching another assignment:
        // its presentation trigger locks the old run, and must not be held
        // while another redispatch acquires project/conversation locks.
        break;
    }
    Ok(changed)
}

async fn mark_resumed(
    tx: &tokio_postgres::Transaction<'_>,
    id: Uuid,
    job_id: Uuid,
) -> ApiResult<()> {
    let changed=tx.execute("update agent_user_input_requests set status='resumed',resumed_job_id=$2,updated_at=now() where id=$1 and status='answered'",
        &[&id,&job_id]).await.map_err(|e|internal_error(format!("record resumed assignment: {e}")))?;
    if changed == 0 {
        crate::user_input_requests::cancel_undeliverable_continuation(tx, id, job_id).await?;
    }
    Ok(())
}

async fn expire(tx: &tokio_postgres::Transaction<'_>, id: Uuid, reason: &str) -> ApiResult<()> {
    tx.execute("update agent_user_input_requests set status='expired',expired_reason=$2,updated_at=now() where id=$1 and status in ('pending','answered')",
        &[&id,&reason]).await.map_err(|e|internal_error(format!("expire waiting assignment: {e}")))?;
    Ok(())
}

async fn record_retry(
    tx: &tokio_postgres::Transaction<'_>,
    id: Uuid,
    previous_attempts: i32,
) -> ApiResult<()> {
    let attempts = previous_attempts + 1;
    if attempts >= 3 {
        return expire(tx,id,"Your answer was saved, but the controller could not restart this assignment after repeated attempts. Start a new request.").await;
    }
    let seconds = i64::from(attempts) * 30;
    tx.execute("update agent_user_input_requests set resume_attempts=$2,resume_after=statement_timestamp()+($3::bigint*interval '1 second'),updated_at=now() where id=$1 and status='answered'",
        &[&id,&attempts,&seconds]).await.map_err(|e|internal_error(format!("defer worker answer retry: {e}")))?;
    Ok(())
}

/// Only a controller continuation can select an old model thread. Revalidate
/// the exact saved assignment after ordinary dispatch resolves current profiles.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn continuation_source_for_dispatch(
    tx: &tokio_postgres::Transaction<'_>,
    context: &RequestContext,
    project_id: Uuid,
    conversation_id: Option<Uuid>,
    metadata: &JsonValue,
    agent_id: Option<Uuid>,
    credential_id: Option<Uuid>,
    agent_handle: &str,
) -> ApiResult<Option<Uuid>> {
    let Some(link) = metadata.pointer("/multiAgentPlan/userInputContinuation") else {
        return Ok(None);
    };
    if !context.is_service_role {
        return Err(crate::forbidden(
            "worker answer continuation is controller-owned",
        ));
    }
    let request_id = link
        .get("requestId")
        .and_then(JsonValue::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(|| bad_request("invalid worker input request"))?;
    let source_job = link
        .get("of")
        .and_then(JsonValue::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(|| bad_request("invalid worker input source"))?;
    let group = metadata
        .pointer("/multiAgentPlan/groupId")
        .and_then(JsonValue::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(|| bad_request("invalid worker input group"))?;
    let row = tx
        .query_opt(
            "select q.*,j.credential_id,r.metadata #>> '{agent,id}' as agent_id,
                r.metadata #>> '{aiAccessMode}' as access_mode
         from agent_user_input_requests q join agent_jobs j on j.id=q.job_id
         join runs r on r.id=j.run_id and r.project_id=j.project_id
         where q.id=$1 and q.job_id=$2 and q.project_id=$3 and q.conversation_id=$4
           and q.group_id=$5 and q.status='answered' and q.answered_by=$6
           and j.status='completed'",
            &[
                &request_id,
                &source_job,
                &project_id,
                &conversation_id,
                &group,
                &context.user_id,
            ],
        )
        .await
        .map_err(|e| internal_error(format!("validate worker continuation binding: {e}")))?
        .ok_or_else(|| {
            crate::forbidden("worker continuation no longer matches its answered assignment")
        })?;
    // The answer may have waited while access changed. A service-role
    // redispatch must not bypass the human's current conversation permissions.
    crate::user_input_requests::authorize_human(
        tx,
        &RequestContext {
            user_id: context.user_id,
            is_service_role: false,
            scoped_claims: None,
        },
        &row,
        true,
    )
    .await?;
    let old_agent: Option<String> = row.get("agent_id");
    let same_agent = match old_agent {
        Some(id) => agent_id.map(|id| id.to_string()).as_deref() == Some(id.as_str()),
        None => {
            normalize_agent_handle(&row.get::<_, String>("agent_handle"))
                == normalize_agent_handle(agent_handle)
        }
    };
    let old_credential: Option<Uuid> = row.get("credential_id");
    let lost_byoc = row.get::<_, Option<String>>("access_mode").as_deref() == Some("byoc")
        && old_credential.is_none();
    if !same_agent || old_credential != credential_id || lost_byoc {
        return Err(crate::forbidden(
            "the worker's original agent or connection is no longer available",
        ));
    }
    Ok(Some(source_job))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn continuation_keeps_original_assignment_and_explicit_answer_without_granting_permissions() {
        let text = continuation_prompt(
            "Inspect only src/a.rs",
            "Read the current diff before editing",
            &json!([{"id":"layout","question":"Which layout?"}]),
            &json!({"layout":["Compact"]}),
        );
        assert!(text.contains("Inspect only src/a.rs"));
        assert!(text.contains("Read the current diff before editing"));
        assert!(text.contains("Compact") && text.contains("Which layout?"));
        assert!(text.contains("not an execution approval"));
    }

    #[tokio::test]
    async fn failed_resume_recovery_is_delayed_bounded_and_cannot_revive_expired_input(
    ) -> anyhow::Result<()> {
        let pool = crate::tests::require_origin_test_pool("bounded worker input recovery").await?;
        let mut connection = pool.get().await?;
        let tx = connection.transaction().await?;
        tx.batch_execute(
            "create temporary table agent_user_input_requests (
            id uuid primary key,status text,resume_attempts integer default 0,
            resume_after timestamptz,updated_at timestamptz,expired_reason text
        ) on commit drop",
        )
        .await?;
        let id = Uuid::new_v4();
        tx.execute(
            "insert into agent_user_input_requests (id,status) values($1,'answered')",
            &[&id],
        )
        .await?;
        for previous in 0..2 {
            record_retry(&tx, id, previous)
                .await
                .expect("save delayed retry");
            let row=tx.query_one("select status,resume_attempts,resume_after>statement_timestamp() as delayed from agent_user_input_requests where id=$1",&[&id]).await?;
            assert_eq!(row.get::<_, String>("status"), "answered");
            assert_eq!(row.get::<_, i32>("resume_attempts"), previous + 1);
            assert!(row.get::<_, bool>("delayed"));
        }
        record_retry(&tx, id, 2)
            .await
            .expect("stop repeated failures");
        record_retry(&tx, id, 0)
            .await
            .expect("late retry cannot resurrect input");
        let row=tx.query_one("select status,resume_attempts,expired_reason from agent_user_input_requests where id=$1",&[&id]).await?;
        assert_eq!(row.get::<_, String>("status"), "expired");
        assert_eq!(row.get::<_, i32>("resume_attempts"), 2);
        assert!(row
            .get::<_, String>("expired_reason")
            .contains("answer was saved"));
        tx.rollback().await?;
        Ok(())
    }
}
