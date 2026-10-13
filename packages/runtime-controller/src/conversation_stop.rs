//! Human Stop cancels only the jobs visible in the caller's snapshot. It does
//! not drain queued messages or turn a stopped plan into a new lead checkpoint.
use std::collections::BTreeSet;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::{
    auth::{authenticate_request, RequestContext},
    conversations, ApiError, AppState,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StopJobsBody {
    job_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopJobsResponse {
    ok: bool,
    canceled_job_ids: Vec<Uuid>,
    canceled_run_ids: Vec<Uuid>,
    already_finished_job_ids: Vec<Uuid>,
}

fn normalize_job_ids(ids: Vec<Uuid>) -> Result<Vec<Uuid>, (StatusCode, Json<ApiError>)> {
    if ids.is_empty() || ids.len() > 100 {
        return Err(crate::bad_request(
            "jobIds must contain between 1 and 100 job IDs",
        ));
    }
    Ok(ids
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

pub(crate) async fn stop_conversation_jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<Uuid>,
    Json(body): Json<StopJobsBody>,
) -> Result<Json<StopJobsResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let ids = normalize_job_ids(body.job_ids)?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| crate::internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| crate::internal_error(format!("failed to start transaction: {error}")))?;
    let (response, cancellation) =
        stop_jobs_in_transaction(&transaction, &context, conversation_id, &ids).await?;
    transaction
        .commit()
        .await
        .map_err(|error| crate::internal_error(format!("failed to commit Stop: {error}")))?;

    if let Some((conversation, cancellation)) = cancellation {
        // The durable cancellation is already accepted. A notification failure
        // must not make the client believe the jobs are still running.
        conversations::publish_job_cancellation_events(
            &state,
            &mut *connection,
            conversation.project_id,
            conversation.id,
            &cancellation,
            "Stopped",
        )
        .await;
    }
    // Deliberately do not spawn_send_queue_drain or checkpoint canceled workers.
    // This acknowledges the controller commit, not physical executor shutdown.
    Ok(Json(response))
}

async fn stop_jobs_in_transaction(
    transaction: &tokio_postgres::Transaction<'_>,
    context: &RequestContext,
    conversation_id: Uuid,
    ids: &[Uuid],
) -> Result<
    (
        StopJobsResponse,
        Option<(
            conversations::ConversationRecord,
            conversations::JobCancellationSet,
        )>,
    ),
    (StatusCode, Json<ApiError>),
> {
    let actor_id = context
        .user_id
        .filter(|_| !context.is_service_role && context.scoped_claims.is_none())
        .ok_or_else(|| crate::forbidden("Stop requires an authenticated human"))?;
    let conversation =
        conversations::load_conversation_record(transaction, &conversation_id).await?;
    let project = crate::load_project_record(transaction, &conversation.project_id).await?;
    crate::ensure_project_write_access(transaction, &project, context, conversation.session_id)
        .await?;
    conversations::ensure_conversation_access(transaction, &conversation, context).await?;

    // Validate every ID before taking any action. Never reinterpret a stale or
    // foreign ID as permission to cancel the rest of the conversation.
    let rows = transaction
        .query(
            "select id, plan_group_id, payload from agent_jobs
         where id = any($1) and project_id = $2
           and coalesce(conversation_id::text, payload->>'conversation_id') = $3",
            &[&ids, &conversation.project_id, &conversation_id.to_string()],
        )
        .await
        .map_err(|error| crate::internal_error(format!("failed to load Stop targets: {error}")))?;
    if rows.len() != ids.len() {
        return Err(crate::bad_request(
            "Every job must belong to this conversation",
        ));
    }
    let groups: BTreeSet<Uuid> = rows
        .iter()
        .filter_map(|row| {
            row.get::<_, Option<Uuid>>("plan_group_id").or_else(|| {
                crate::active_job_auth::payload_plan_group_id(
                    &row.get::<_, PgJson<Value>>("payload").0,
                )
            })
        })
        .collect();
    // Use the exact same lock as checkpoint creation, in a stable order for
    // multi-group requests. A checkpoint committed before this lock is acquired
    // is new work outside the selected snapshot and is never silently canceled.
    for group in &groups {
        crate::multi_agent_plan::lock_plan_group_checkpoint(transaction, &group.to_string())
            .await?;
    }
    let rows = transaction
        .query(
            "select id, run_id, status, payload from agent_jobs
         where id = any($1) and project_id = $2
           and coalesce(conversation_id::text, payload->>'conversation_id') = $3
         order by id for update",
            &[&ids, &conversation.project_id, &conversation_id.to_string()],
        )
        .await
        .map_err(|error| crate::internal_error(format!("failed to lock Stop targets: {error}")))?;
    if rows.len() != ids.len() {
        return Err(crate::bad_request(
            "Every job must belong to this conversation",
        ));
    }
    let mut jobs = Vec::new();
    let mut finished = Vec::new();
    let mut agents = Vec::new();
    let mut handles = BTreeSet::new();
    for row in rows {
        let id: Uuid = row.get("id");
        if !matches!(row.get::<_, String>("status").as_str(), "queued" | "leased") {
            finished.push(id);
            continue;
        }
        let run_id: Option<Uuid> = row.get("run_id");
        let payload = row.get::<_, PgJson<Value>>("payload").0;
        let handle = payload
            .pointer("/metadata/agent/handle")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|handle| !handle.is_empty());
        if let Some(handle) = handle {
            handles.insert(handle.to_string());
        }
        agents.push(json!({"jobId": id, "runId": run_id, "handle": handle}));
        jobs.push((id, run_id));
    }
    let job_ids: Vec<Uuid> = jobs.iter().map(|(job, _)| *job).collect();
    let run_ids: Vec<Uuid> = jobs
        .iter()
        .filter_map(|(_, run)| *run)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let response = StopJobsResponse {
        ok: true,
        canceled_job_ids: job_ids.clone(),
        canceled_run_ids: run_ids.clone(),
        already_finished_job_ids: finished,
    };
    if jobs.is_empty() {
        return Ok((response, None));
    }

    let mut suppressed_groups = Vec::new();
    for group in groups {
        let workers = transaction.query(
            "select id from agent_jobs where project_id = $1
               and coalesce(conversation_id::text, payload->>'conversation_id') = $2
               and (plan_group_id = $3 or payload #>> '{metadata,multiAgentPlan,groupId}' = $4
                    or payload #>> '{metadata,multi_agent_plan,group_id}' = $4)
               and coalesce(agent_role, payload #>> '{metadata,multiAgentPlan,role}', payload #>> '{metadata,multi_agent_plan,role}') = 'worker'
               and status in ('queued', 'leased')",
            &[&conversation.project_id, &conversation_id.to_string(), &group, &group.to_string()],
        ).await.map_err(|error| crate::internal_error(format!("failed to inspect stopped plan: {error}")))?;
        if !workers.is_empty()
            && workers
                .iter()
                .all(|row| job_ids.contains(&row.get::<_, Uuid>("id")))
        {
            suppressed_groups.push(group.to_string());
        }
    }
    let mut notice = conversations::build_interruption_notice("Stopped", &job_ids, &run_ids);
    notice.content = if jobs.len() == 1 {
        "Stopped this run.".into()
    } else {
        format!("Stopped {} runs.", jobs.len())
    };
    let details = notice.metadata["details"]
        .as_object_mut()
        .expect("notice details object");
    details.insert("actorUserId".into(), json!(actor_id));
    details.insert("stopRequested".into(), json!(true));
    details.insert("agents".into(), json!(agents));
    details.insert("agentHandles".into(), json!(handles));
    details.insert("suppressedPlanGroupIds".into(), json!(suppressed_groups));
    let cancellation = conversations::cancel_jobs_with_notice(
        transaction,
        &conversation.project_id,
        &conversation_id,
        conversation.session_id,
        &jobs,
        "Stopped",
        Some(notice),
    )
    .await?;
    Ok((response, Some((conversation, cancellation))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_requires_bounded_exact_job_ids() {
        assert!(normalize_job_ids(Vec::new()).is_err());
        assert!(normalize_job_ids(vec![Uuid::new_v4(); 101]).is_err());
        let id = Uuid::new_v4();
        assert_eq!(normalize_job_ids(vec![id, id]).unwrap(), vec![id]);
        assert!(serde_json::from_value::<StopJobsBody>(json!({"jobIds": ["invalid"]})).is_err());
        assert!(
            serde_json::from_value::<StopJobsBody>(json!({"jobIds": [id], "actorUserId": id}))
                .is_err()
        );
    }

    #[tokio::test]
    async fn stop_jobs_are_exact_authorized_idempotent_and_preserve_queued_messages(
    ) -> anyhow::Result<()> {
        let pool = crate::tests::require_origin_test_pool(
            "stop_jobs_are_exact_authorized_idempotent_and_preserve_queued_messages",
        )
        .await?;
        let mut connection = pool.get().await?;
        // The entire fixture is rolled back, including users, even on failure.
        let mut tx = connection.transaction().await?;
        let owner = Uuid::new_v4();
        let viewer = Uuid::new_v4();
        let builder = Uuid::new_v4();
        for user in [owner, viewer, builder] {
            tx.execute(
                "insert into auth.users (id, email) values ($1, $2)",
                &[&user, &format!("stop-test-{user}@example.com")],
            )
            .await?;
        }
        let project = Uuid::new_v4();
        let conversation = Uuid::new_v4();
        let other_conversation = Uuid::new_v4();
        let group = Uuid::new_v4();
        let batch_group = Uuid::new_v4();
        tx.execute(
            "insert into projects (id, owner_user_id) values ($1, $2)",
            &[&project, &owner],
        )
        .await?;
        tx.execute("insert into project_memberships (project_id,user_id,role) values ($1,$2,'viewer'),($1,$3,'builder')", &[&project,&viewer,&builder]).await?;
        for id in [conversation, other_conversation] {
            tx.execute("insert into conversations (id,project_id,created_by,visibility) values ($1,$2,$3,'private')", &[&id,&project,&owner]).await?;
        }
        let mut jobs = Vec::new();
        let mut runs = Vec::new();
        for index in 0..6 {
            let job = Uuid::new_v4();
            let run = Uuid::new_v4();
            let target = if index == 2 {
                other_conversation
            } else {
                conversation
            };
            let (job_status, run_status) = if index == 3 {
                ("completed", "success")
            } else {
                ("leased", "in_progress")
            };
            tx.execute("insert into runs (id,project_id,conversation_id,run_type,status,metadata) values ($1,$2,$3,'prompt',$4,$5)", &[&run,&project,&target,&run_status,&PgJson(json!({"initiatingUserId":viewer}))]).await?;
            let target_group = if index >= 4 { batch_group } else { group };
            let payload = json!({"user_id":owner, "metadata":{"agent":{"handle":format!("worker{index}")},"multiAgentPlan":{"groupId":target_group,"role":"worker"}}});
            tx.execute("insert into agent_jobs (id,project_id,conversation_id,run_id,status,payload,plan_group_id,agent_role,lease_expires_at) values ($1,$2,$3,$4,$5,$6,$7,'worker',now()+interval '1 minute')", &[&job,&project,&target,&run,&job_status,&PgJson(payload),&target_group]).await?;
            jobs.push(job);
            runs.push(run);
        }
        let queue_id = Uuid::new_v4();
        tx.execute("insert into conversation_send_queue (id,project_id,conversation_id,user_id,request) values ($1,$2,$3,$4,'{}')", &[&queue_id,&project,&conversation,&owner]).await?;
        let context = |user_id| RequestContext {
            user_id: Some(user_id),
            is_service_role: false,
            scoped_claims: None,
        };
        for user in [viewer, builder] {
            let error = stop_jobs_in_transaction(&tx, &context(user), conversation, &[jobs[0]])
                .await
                .err()
                .expect("viewer/private nonparticipant denied");
            assert_eq!(error.0, StatusCode::FORBIDDEN);
        }
        let service = RequestContext {
            user_id: Some(owner),
            is_service_role: true,
            scoped_claims: None,
        };
        assert_eq!(
            stop_jobs_in_transaction(&tx, &service, conversation, &[jobs[0]])
                .await
                .err()
                .unwrap()
                .0,
            StatusCode::FORBIDDEN
        );
        for foreign in [jobs[2], Uuid::new_v4()] {
            assert_eq!(
                stop_jobs_in_transaction(&tx, &context(owner), conversation, &[jobs[0], foreign])
                    .await
                    .err()
                    .unwrap()
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            tx.query_one("select status from agent_jobs where id=$1", &[&jobs[0]])
                .await?
                .get::<_, String>(0),
            "leased"
        );
        let (response, cancellation) =
            stop_jobs_in_transaction(&tx, &context(owner), conversation, &[jobs[0], jobs[3]])
                .await
                .map_err(api_error)?;
        assert_eq!(response.canceled_job_ids, vec![jobs[0]]);
        assert_eq!(response.canceled_run_ids, vec![runs[0]]);
        assert_eq!(response.already_finished_job_ids, vec![jobs[3]]);
        let notice = cancellation.unwrap().1.notice;
        assert_eq!(notice.metadata["details"]["actorUserId"], json!(owner));
        assert_eq!(
            notice.metadata["details"]["agentHandles"],
            json!(["worker0"])
        );
        assert_eq!(
            notice.metadata["details"]["suppressedPlanGroupIds"],
            json!([])
        );
        assert!(!crate::multi_agent_plan::plan_group_was_stopped(
            &tx,
            project,
            conversation,
            &group.to_string()
        )
        .await
        .map_err(api_error)?);
        let (repeat, cancellation) =
            stop_jobs_in_transaction(&tx, &context(owner), conversation, &[jobs[0]])
                .await
                .map_err(api_error)?;
        assert!(repeat.canceled_job_ids.is_empty());
        assert_eq!(repeat.already_finished_job_ids, vec![jobs[0]]);
        assert!(cancellation.is_none());
        assert_eq!(
            tx.query_one(
                "select count(*) from conversation_messages where conversation_id=$1",
                &[&conversation]
            )
            .await?
            .get::<_, i64>(0),
            1
        );
        let snapshot = crate::runs::load_run_snapshot(&mut tx, &runs[0])
            .await
            .map_err(api_error)?
            .unwrap();
        assert_eq!(snapshot.metadata.unwrap()["initiatingUserId"], json!(owner));
        assert_eq!(
            tx.query_one("select status from agent_jobs where id=$1", &[&jobs[2]])
                .await?
                .get::<_, String>(0),
            "leased"
        );
        let (response, _) =
            stop_jobs_in_transaction(&tx, &context(owner), conversation, &[jobs[1]])
                .await
                .map_err(api_error)?;
        assert_eq!(response.canceled_job_ids, vec![jobs[1]]);
        assert!(crate::multi_agent_plan::plan_group_was_stopped(
            &tx,
            project,
            conversation,
            &group.to_string()
        )
        .await
        .map_err(api_error)?);
        assert!(!crate::multi_agent_plan::plan_group_was_stopped(
            &tx,
            project,
            other_conversation,
            &group.to_string()
        )
        .await
        .map_err(api_error)?);
        assert_eq!(
            tx.query_one(
                "select status from conversation_send_queue where id=$1",
                &[&queue_id]
            )
            .await?
            .get::<_, String>(0),
            "queued"
        );
        assert!(tx
            .query_one(
                "select lease_expires_at is null from agent_jobs where id=$1",
                &[&jobs[1]]
            )
            .await?
            .get::<_, bool>(0));
        let (batch, _) =
            stop_jobs_in_transaction(&tx, &context(owner), conversation, &[jobs[4], jobs[5]])
                .await
                .map_err(api_error)?;
        assert_eq!(batch.canceled_job_ids.len(), 2);
        assert_eq!(batch.canceled_run_ids.len(), 2);
        assert!(batch.already_finished_job_ids.is_empty());
        assert!(crate::multi_agent_plan::plan_group_was_stopped(
            &tx,
            project,
            conversation,
            &batch_group.to_string()
        )
        .await
        .map_err(api_error)?);
        tx.rollback().await?;
        Ok(())
    }

    fn api_error((status, Json(error)): (StatusCode, Json<ApiError>)) -> anyhow::Error {
        anyhow::anyhow!("{}: {}", status, error.message)
    }
}
