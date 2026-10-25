//! Canceling the work of a deleted space.
//!
//! Deleting a space cancels, in the transaction that marks it deleted, its
//! queued and leased agent jobs with their runs and open provider requests,
//! any other open run, its queued send-queue entries, and pauses its active
//! automations. Work that
//! reaches the space after that commit (a dispatch that raced the delete, or
//! a job a runtime stop requeued) is canceled the same way by
//! [`cancel_deleted_project_work`]: after each stop of the space's runtimes,
//! and by the idle sweep's deleted-space step for a space deleted a while
//! ago that still has some, so a dispatch that commits after the last of
//! those stops is canceled too.
//!
//! Nothing here dispatches: no send-queue drain and no plan checkpoint, since
//! dispatch into a deleted space is refused. Nothing about the space's own
//! items is published either: every subscriber's per-event access check would
//! drop it. A managed-AI reserve carried by a queued job no runtime ever held
//! is refunded through the gate the expiry sweeps use; a job a runtime held
//! keeps its charge, as it does after Stop.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Context;
use axum::{http::StatusCode, Json};
use serde_json::{json, Value};
use tokio_postgres::error::SqlState;
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::{conversations, internal_error, ApiError, AppState};

/// The summary, run message and cancellation reason recorded on everything a
/// space delete cancels, and the reason on its managed-AI refunds.
pub(crate) const SPACE_DELETED_REASON: &str = "space_deleted";

const SPACE_DELETED_NOTICE: &str =
    "This space was deleted, so its running and queued work was canceled.";

/// The code of a cancel Postgres ended as one side of a deadlock. The cancel
/// locks the space's live jobs in id order, as a conversation's stop does,
/// but a steer locks a conversation's jobs in creation order and several
/// stops and sweeps update many jobs in no set order. The whole transaction
/// is rolled back, so the caller may run it again.
pub(crate) const CANCEL_DEADLOCKED_CODE: &str = "deadlock_detected";

/// The failure of one of the cancel's statements, `context` first. A
/// deadlock carries [`CANCEL_DEADLOCKED_CODE`] and is left for the caller to
/// log, since it may retry.
fn cancel_failure(context: &str, error: tokio_postgres::Error) -> (StatusCode, Json<ApiError>) {
    let message = format!("{context}: {}", crate::errors::describe_db_error(&error));
    if error.code() == Some(&SqlState::T_R_DEADLOCK_DETECTED) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                message,
                code: Some(CANCEL_DEADLOCKED_CODE.to_string()),
                details: None,
            }),
        );
    }
    internal_error(message)
}

/// What canceling a deleted space's work changed.
#[derive(Debug, Default)]
pub(crate) struct ProjectWorkCancellation {
    pub(crate) canceled_job_ids: Vec<Uuid>,
    /// The runs of those jobs, and open runs no live job owned.
    pub(crate) canceled_run_ids: Vec<Uuid>,
    pub(crate) canceled_send_queue_entries: u64,
    pub(crate) expired_user_input_requests: u64,
    pub(crate) paused_automations: u64,
    /// Orgs a managed-AI refund was written for, each owed a
    /// `credits.updated` once the transaction commits.
    pub(crate) refunded_org_ids: BTreeSet<Uuid>,
}

impl ProjectWorkCancellation {
    pub(crate) fn is_empty(&self) -> bool {
        self.canceled_job_ids.is_empty()
            && self.canceled_run_ids.is_empty()
            && self.canceled_send_queue_entries == 0
            && self.expired_user_input_requests == 0
            && self.paused_automations == 0
            && self.refunded_org_ids.is_empty()
    }
}

/// A live job of the space, locked for cancellation.
struct LiveJob {
    id: Uuid,
    run_id: Option<Uuid>,
    plan_group_id: Option<Uuid>,
}

/// Cancel the queued and in-flight work of `project_id`, a deleted space.
/// Idempotent: what an earlier call canceled is no longer queued, leased or
/// open. It takes no plan-group lock and locks no runtime or lease row: in a
/// delete, `transaction` already holds the space's row, and a holder of one
/// of those locks may itself be waiting for that row.
pub(crate) async fn cancel_project_work_in_transaction(
    config: &crate::config::AppConfig,
    transaction: &mut tokio_postgres::Transaction<'_>,
    project_id: Uuid,
) -> Result<ProjectWorkCancellation, (StatusCode, Json<ApiError>)> {
    let mut work = ProjectWorkCancellation::default();

    // The job cancel has no status guard, so lock exactly the jobs that are
    // still live; a job that completes first is left as it finished.
    let rows = transaction
        .query(
            "select id, run_id, status, lease_attempts, payload, plan_group_id, conversation_id
             from agent_jobs
             where project_id = $1 and status in ('queued', 'leased')
             order by id
             for update",
            &[&project_id],
        )
        .await
        .map_err(|error| cancel_failure("failed to lock the space's live jobs", error))?;

    let mut by_conversation: BTreeMap<Uuid, Vec<LiveJob>> = BTreeMap::new();
    let mut without_conversation: Vec<(Uuid, Option<Uuid>)> = Vec::new();
    for row in &rows {
        let payload = row.get::<_, PgJson<Value>>("payload").0;
        let job = LiveJob {
            id: row.get("id"),
            run_id: row.get("run_id"),
            plan_group_id: row
                .get::<_, Option<Uuid>>("plan_group_id")
                .or_else(|| crate::active_job_auth::payload_plan_group_id(&payload)),
        };
        let lease_attempts: i32 = row.get("lease_attempts");
        // A queued job no runtime ever held never reached a model. One a
        // runtime held (leased now, or requeued by a stop) keeps its charge.
        if row.get::<_, String>("status") == "queued" && lease_attempts == 0 {
            if let Some(org_id) = crate::runtime::refund_managed_ai_reserve_for_expired_job(
                transaction,
                &project_id,
                &job.id,
                job.run_id,
                lease_attempts,
                &payload,
                SPACE_DELETED_REASON,
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to refund a deleted space's queued job: {error:#}"
                ))
            })? {
                work.refunded_org_ids.insert(org_id);
            }
        }
        let conversation_id = row.get::<_, Option<Uuid>>("conversation_id").or_else(|| {
            payload
                .get("conversation_id")
                .and_then(Value::as_str)
                .and_then(|value| Uuid::parse_str(value.trim()).ok())
        });
        match conversation_id {
            Some(conversation_id) => by_conversation
                .entry(conversation_id)
                .or_default()
                .push(job),
            None => without_conversation.push((job.id, job.run_id)),
        }
    }

    // The cancellation notice needs the conversation row. A conversation id
    // only the payload still names (the row is gone) or one of another space
    // gets its jobs canceled without a notice instead of failing the delete.
    let sessions: BTreeMap<Uuid, Option<Uuid>> = if by_conversation.is_empty() {
        BTreeMap::new()
    } else {
        let conversation_ids: Vec<Uuid> = by_conversation.keys().copied().collect();
        transaction
            .query(
                "select id, session_id from conversations where id = any($1) and project_id = $2",
                &[&conversation_ids, &project_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to load the space's conversations: {error}"))
            })?
            .iter()
            .map(|row| (row.get("id"), row.get("session_id")))
            .collect()
    };

    for (conversation_id, jobs) in by_conversation {
        let pairs: Vec<(Uuid, Option<Uuid>)> =
            jobs.iter().map(|job| (job.id, job.run_id)).collect();
        let Some(session_id) = sessions.get(&conversation_id).copied() else {
            without_conversation.extend(pairs);
            continue;
        };
        let job_ids: Vec<Uuid> = jobs.iter().map(|job| job.id).collect();
        let run_ids: Vec<Uuid> = jobs.iter().filter_map(|job| job.run_id).collect();
        // Every live job of the space is canceled, so every plan group in
        // the conversation is stopped: a late lead checkpoint must not start.
        let groups: BTreeSet<Uuid> = jobs.iter().filter_map(|job| job.plan_group_id).collect();
        let mut notice =
            conversations::build_interruption_notice(SPACE_DELETED_REASON, &job_ids, &run_ids);
        notice.content = SPACE_DELETED_NOTICE.to_string();
        let details = notice.metadata["details"]
            .as_object_mut()
            .expect("notice details object");
        details.insert("stopRequested".into(), json!(true));
        details.insert("suppressedPlanGroupIds".into(), json!(groups));
        let canceled = conversations::cancel_jobs_with_notice(
            config,
            transaction,
            &project_id,
            &conversation_id,
            session_id,
            &pairs,
            SPACE_DELETED_REASON,
            Some(notice),
        )
        .await?;
        work.canceled_job_ids.extend(canceled.job_ids);
        work.canceled_run_ids
            .extend(canceled.pairs.iter().map(|(_, run_id)| *run_id));
    }

    if !without_conversation.is_empty() {
        let canceled = conversations::cancel_jobs_and_runs(
            transaction,
            &without_conversation,
            SPACE_DELETED_REASON,
        )
        .await?;
        work.canceled_job_ids.extend(canceled.job_ids);
        work.canceled_run_ids.extend(canceled.run_ids);
    }

    // Completed workers release their lease while awaiting a human. They no
    // longer appear among live jobs, but a deleted space must not resume them.
    work.expired_user_input_requests = crate::user_input_requests::expire_requests(
        transaction,
        project_id,
        None,
        None,
        SPACE_DELETED_REASON,
    )
    .await?
    .len() as u64;

    // Runs still open with no live job behind them would otherwise show as
    // live work forever.
    let open_run_ids: Vec<Uuid> = transaction
        .query(
            "update runs
             set status = 'canceled',
                 progress_stage = null,
                 last_message = $2,
                 updated_at = now()
             where project_id = $1
               and status in ('queued', 'in_progress', 'awaiting_approval')
             returning id",
            &[&project_id, &SPACE_DELETED_REASON],
        )
        .await
        .map_err(|error| cancel_failure("failed to cancel the space's open runs", error))?
        .iter()
        .map(|row| row.get("id"))
        .collect();
    if !open_run_ids.is_empty() {
        conversations::persist_canceled_run_metadata(
            transaction,
            &open_run_ids,
            SPACE_DELETED_REASON,
        )
        .await?;
        work.canceled_run_ids.extend(open_run_ids);
    }

    work.canceled_send_queue_entries = crate::send_queue::cancel_queued_entries_for_project(
        &*transaction,
        project_id,
        SPACE_DELETED_REASON,
    )
    .await
    .map_err(|error| {
        internal_error(format!(
            "failed to cancel the space's queued messages: {error}"
        ))
    })?;
    work.paused_automations =
        crate::automations::pause_active_automations_for_project(&*transaction, project_id)
            .await
            .map_err(|error| {
                internal_error(format!("failed to pause the space's automations: {error}"))
            })?;

    Ok(work)
}

/// Once the transaction that canceled `work` has committed: log it and send
/// each refunded org a `credits.updated`. That signal goes out on the org's
/// spaces that are not deleted, so no subscriber's access check on the
/// deleted space drops it. `client` must not be that transaction.
pub(crate) async fn publish_project_work_cancellation(
    state: &AppState,
    client: &impl tokio_postgres::GenericClient,
    project_id: Uuid,
    work: &ProjectWorkCancellation,
) {
    if work.is_empty() {
        return;
    }
    tracing::info!(
        project_id = %project_id,
        canceled_jobs = work.canceled_job_ids.len(),
        canceled_runs = work.canceled_run_ids.len(),
        canceled_send_queue_entries = work.canceled_send_queue_entries,
        expired_user_input_requests = work.expired_user_input_requests,
        paused_automations = work.paused_automations,
        refunded_orgs = work.refunded_org_ids.len(),
        "canceled the work of a deleted space"
    );
    for org_id in &work.refunded_org_ids {
        crate::credits::publish_credits_updated(
            state,
            client,
            *org_id,
            crate::credits::CREDITS_UPDATED_LEDGER,
        )
        .await;
    }
}

/// Cancel work that reached the deleted space `project_id` after its delete
/// committed: a dispatch that raced the delete, or a job a runtime stop
/// requeued. A no-op unless the space is deleted, and idempotent. It runs
/// its own short transaction on a pooled connection and publishes before it
/// gives the connection back, so call it outside any transaction and with no
/// runtime or lease row locked.
pub(crate) async fn cancel_deleted_project_work(
    state: &AppState,
    project_id: Uuid,
) -> anyhow::Result<ProjectWorkCancellation> {
    let mut connection = state
        .pool
        .get()
        .await
        .context("failed to get a connection to cancel a deleted space's work")?;
    let mut transaction = connection
        .transaction()
        .await
        .context("failed to start the deleted space's cancel transaction")?;
    // A deleted space is never restored, so no lock is needed to trust this.
    let deleted = transaction
        .query_opt(
            "select 1 from projects where id = $1 and status = 'deleted'",
            &[&project_id],
        )
        .await
        .context("failed to check whether the space is deleted")?
        .is_some();
    if !deleted {
        return Ok(ProjectWorkCancellation::default());
    }
    let work = cancel_project_work_in_transaction(&state.config, &mut transaction, project_id)
        .await
        .map_err(|(status, Json(error))| {
            anyhow::anyhow!(
                "failed to cancel the deleted space's work ({status}): {}",
                error.message
            )
        })?;
    transaction
        .commit()
        .await
        .context("failed to commit the deleted space's cancel transaction")?;
    publish_project_work_cancellation(state, &*connection, project_id, &work).await;
    Ok(work)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{build_test_state, with_shared_db_fixture, SharedDbFixture};
    use crate::tests_managed_ai_refund::{
        prompt_metadata, seed_reserved_managed_ai_prompt, ReservedManagedAiPrompt,
    };
    use axum::{body::Body, http::Request};
    use tokio_postgres::GenericClient;
    use tower::ServiceExt;

    fn api_error((status, Json(error)): (StatusCode, Json<ApiError>)) -> anyhow::Error {
        anyhow::anyhow!("{status}: {}", error.message)
    }

    async fn delete_space(
        state: &AppState,
        project_id: Uuid,
        token: &str,
    ) -> anyhow::Result<StatusCode> {
        let response = crate::projects::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/projects/{project_id}"))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())?,
            )
            .await?;
        Ok(response.status())
    }

    async fn insert_run(
        client: &impl GenericClient,
        project_id: Uuid,
        conversation_id: Option<Uuid>,
        status: &str,
    ) -> anyhow::Result<Uuid> {
        let run_id = Uuid::new_v4();
        client
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status)
                 values ($1, $2, $3, 'prompt', $4)",
                &[&run_id, &project_id, &conversation_id, &status],
            )
            .await?;
        Ok(run_id)
    }

    /// A job and its run. A `leased` job gets a live lease.
    #[allow(clippy::too_many_arguments)]
    async fn insert_job(
        client: &impl GenericClient,
        project_id: Uuid,
        conversation_id: Option<Uuid>,
        status: &str,
        lease_attempts: i32,
        run_status: &str,
        payload: Value,
        plan_group_id: Option<Uuid>,
    ) -> anyhow::Result<(Uuid, Uuid)> {
        let run_id = insert_run(client, project_id, conversation_id, run_status).await?;
        let job_id = Uuid::new_v4();
        client
            .execute(
                "insert into agent_jobs
                   (id, project_id, conversation_id, run_id, status, lease_attempts, payload,
                    plan_group_id, lease_expires_at)
                 values ($1, $2, $3, $4, $5, $6, $7, $8,
                         case when $5 = 'leased' then now() + interval '1 minute' end)",
                &[
                    &job_id,
                    &project_id,
                    &conversation_id,
                    &run_id,
                    &status,
                    &lease_attempts,
                    &PgJson(payload),
                    &plan_group_id,
                ],
            )
            .await?;
        Ok((job_id, run_id))
    }

    async fn queue_entry(
        client: &impl GenericClient,
        project_id: Uuid,
        conversation_id: Uuid,
        user_id: Option<Uuid>,
        status: &str,
    ) -> anyhow::Result<Uuid> {
        let entry_id = Uuid::new_v4();
        client
            .execute(
                "insert into conversation_send_queue
                   (id, project_id, conversation_id, user_id, status, request)
                 values ($1, $2, $3, $4, $5, '{}')",
                &[&entry_id, &project_id, &conversation_id, &user_id, &status],
            )
            .await?;
        Ok(entry_id)
    }

    async fn refunds(
        client: &impl GenericClient,
        project_id: Uuid,
    ) -> anyhow::Result<Vec<(Option<String>, Option<String>)>> {
        Ok(client
            .query(
                "select idempotency_key, metadata ->> 'refundReason'
                 from org_credit_ledger
                 where project_id = $1 and reason = $2
                 order by created_at",
                &[&project_id, &crate::credits::MANAGED_AI_REFUND_REASON],
            )
            .await?
            .iter()
            .map(|row| (row.get(0), row.get(1)))
            .collect())
    }

    async fn cancellation_notices(
        client: &impl GenericClient,
        conversation_id: Uuid,
    ) -> anyhow::Result<Vec<(String, Value)>> {
        Ok(client
            .query(
                "select content, metadata from conversation_messages
                 where conversation_id = $1 and metadata ->> 'kind' = 'run_cancellation'",
                &[&conversation_id],
            )
            .await?
            .iter()
            .map(|row| (row.get(0), row.get::<_, PgJson<Value>>(1).0))
            .collect())
    }

    /// Runs the body with the seeded org cleaned up however it ends, then
    /// removes what the org's cascade does not reach.
    async fn with_seeded_space(
        fixture: &ReservedManagedAiPrompt,
        extra_projects: &[Uuid],
        body: impl std::future::Future<Output = anyhow::Result<()>>,
    ) -> anyhow::Result<()> {
        let outcome = with_shared_db_fixture(
            SharedDbFixture {
                organizations: vec![fixture.org_id],
                projects: Vec::new(),
            },
            body,
        )
        .await;
        let mut projects = extra_projects.to_vec();
        projects.push(fixture.project_id);
        let cleanup = async {
            fixture
                .pool
                .get()
                .await?
                .execute("delete from runs where project_id = any($1)", &[&projects])
                .await?;
            fixture.cleanup().await
        }
        .await;
        outcome.and(cleanup)
    }

    #[tokio::test]
    async fn deleting_a_space_cancels_its_work_and_refunds_only_never_leased_jobs(
    ) -> anyhow::Result<()> {
        let Some(fixture) = seed_reserved_managed_ai_prompt("space-delete-cancel").await? else {
            eprintln!("skipping space delete cancellation test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let other_project = Uuid::new_v4();
        with_seeded_space(&fixture, &[other_project], async {
            let pool = &fixture.pool;
            let project = fixture.project_id;
            let owner = fixture.owner_user_id;
            let member = fixture.other_user_id;
            let connection = pool.get().await?;
            let chat: Uuid = connection
                .query_one(
                    "select conversation_id from agent_jobs where id = $1",
                    &[&fixture.job_id],
                )
                .await?
                .get(0);
            let plan_chat = Uuid::new_v4();
            connection
                .execute(
                    "insert into conversations (id, project_id, created_by, visibility)
                     values ($1, $2, $3, 'public')",
                    &[&plan_chat, &project, &owner],
                )
                .await?;
            connection
                .execute(
                    "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                     values ($1, $2, 'Other space', $3, 'customer', 'active')",
                    &[&other_project, &fixture.org_id, &owner],
                )
                .await?;

            // A stop requeued this managed-AI job after a runtime held it, so
            // its reserve may have paid for a model turn.
            let requeued_prompt = Uuid::new_v4();
            let (requeued, requeued_run) = insert_job(
                &*connection,
                project,
                Some(chat),
                "queued",
                1,
                "in_progress",
                json!({ "prompt_id": requeued_prompt, "metadata": { "managedAiUsed": true } }),
                None,
            )
            .await?;
            {
                let mut connection = pool.get().await?;
                let transaction = connection.transaction().await?;
                crate::credits::process_credit_burn(
                    &transaction,
                    &project,
                    &fixture.org_id,
                    None,
                    fixture.burn_amount,
                    "managed_ai_prompt",
                    Some(&format!("managed-ai-prompt:{requeued_prompt}")),
                    &mut json!({ "source": "managed_ai", "promptId": requeued_prompt }),
                )
                .await
                .map_err(api_error)?;
                transaction.commit().await?;
            }
            let (leased, leased_run) = insert_job(
                &*connection,
                project,
                Some(chat),
                "leased",
                1,
                "in_progress",
                json!({}),
                None,
            )
            .await?;
            let (completed, completed_run) = insert_job(
                &*connection,
                project,
                Some(chat),
                "completed",
                1,
                "success",
                json!({}),
                None,
            )
            .await?;
            let group = Uuid::new_v4();
            let (worker, worker_run) = insert_job(
                &*connection,
                project,
                Some(plan_chat),
                "leased",
                1,
                "in_progress",
                json!({}),
                Some(group),
            )
            .await?;
            // Only the payload names this worker's conversation and group.
            let (payload_worker, payload_worker_run) = insert_job(
                &*connection,
                project,
                None,
                "queued",
                0,
                "queued",
                json!({
                    "conversation_id": plan_chat.to_string(),
                    "metadata": { "multiAgentPlan": { "groupId": group, "role": "worker" } }
                }),
                None,
            )
            .await?;
            let (unthreaded, unthreaded_run) = insert_job(
                &*connection,
                project,
                None,
                "queued",
                0,
                "queued",
                json!({}),
                None,
            )
            .await?;
            // The payload still names a conversation whose row is gone.
            let (dangling, dangling_run) = insert_job(
                &*connection,
                project,
                None,
                "queued",
                0,
                "queued",
                json!({ "conversation_id": Uuid::new_v4().to_string() }),
                None,
            )
            .await?;
            let orphan_run = insert_run(&*connection, project, Some(chat), "in_progress").await?;
            let (other_job, other_run) = insert_job(
                &*connection,
                other_project,
                None,
                "queued",
                0,
                "queued",
                json!({}),
                None,
            )
            .await?;

            let queued_entries = vec![
                queue_entry(&*connection, project, chat, Some(owner), "queued").await?,
                queue_entry(&*connection, project, plan_chat, Some(member), "queued").await?,
                queue_entry(&*connection, project, chat, None, "queued").await?,
            ];
            let dispatched_entry =
                queue_entry(&*connection, project, chat, Some(owner), "dispatched").await?;

            let mut automations = Vec::new();
            for status in ["active", "paused"] {
                let automation_id = Uuid::new_v4();
                connection
                    .execute(
                        "insert into automations (
                             id, project_id, user_id, name, prompt_text, schedule_kind,
                             interval_hours, timezone, runtime_mode, status, next_run_at
                         ) values (
                             $1, $2, $3, 'Nightly check', 'Check the space.', 'hourly',
                             24, 'UTC', 'existing', $4, '2100-01-01T00:00:00Z'
                         )",
                        &[&automation_id, &project, &owner, &status],
                    )
                    .await?;
                automations.push(automation_id);
            }
            drop(connection);

            // A fresh hub, so the org's first credits.updated is not folded
            // into one the seed's dispatch already sent.
            let state = build_test_state(pool.clone(), fixture.config.clone());
            let _watch_deleted = state.events.watch_project(project);
            let _watch_other = state.events.watch_project(other_project);
            let mut events = state.events.subscribe();
            let token = crate::auth::issue_controller_token(&fixture.config, &owner)
                .map_err(api_error)?
                .token;
            assert_eq!(
                delete_space(&state, project, &token).await?,
                StatusCode::NO_CONTENT
            );

            let mut credit_signals = Vec::new();
            let mut item_events = Vec::new();
            while let Ok(event) = events.try_recv() {
                if event.kind == crate::credits::CREDITS_UPDATED_EVENT {
                    credit_signals.push(event.project_id);
                } else if event.project_id == Some(project)
                    && (event.conversation_id.is_some()
                        || event.run_id.is_some()
                        || event.job_id.is_some())
                {
                    item_events.push(event.kind);
                }
            }
            assert_eq!(
                credit_signals,
                vec![Some(other_project)],
                "one credits.updated, on the org's spaces that are not deleted"
            );
            assert!(
                item_events.is_empty(),
                "every subscriber would drop events about the deleted space: {item_events:?}"
            );

            let connection = pool.get().await?;
            let live: i64 = connection
                .query_one(
                    "select count(*) from agent_jobs
                     where project_id = $1 and status in ('queued', 'leased')",
                    &[&project],
                )
                .await?
                .get(0);
            assert_eq!(live, 0);
            for job in [
                fixture.job_id,
                requeued,
                leased,
                worker,
                payload_worker,
                unthreaded,
                dangling,
            ] {
                let row = connection
                    .query_one(
                        "select status, summary, lease_expires_at is null from agent_jobs
                         where id = $1",
                        &[&job],
                    )
                    .await?;
                assert_eq!(
                    (
                        row.get::<_, String>(0),
                        row.get::<_, Option<String>>(1),
                        row.get::<_, bool>(2)
                    ),
                    (
                        "canceled".to_string(),
                        Some(SPACE_DELETED_REASON.into()),
                        true
                    ),
                    "job {job}"
                );
            }
            for run in [
                fixture.run_id,
                requeued_run,
                leased_run,
                worker_run,
                payload_worker_run,
                unthreaded_run,
                dangling_run,
                orphan_run,
            ] {
                let row = connection
                    .query_one(
                        "select status, metadata #>> '{cancellation,summary}' from runs
                         where id = $1",
                        &[&run],
                    )
                    .await?;
                assert_eq!(
                    (row.get::<_, String>(0), row.get::<_, Option<String>>(1)),
                    ("canceled".to_string(), Some(SPACE_DELETED_REASON.into())),
                    "run {run}"
                );
            }
            for (job, run, job_status, run_status) in [
                (completed, completed_run, "completed", "success"),
                (other_job, other_run, "queued", "queued"),
            ] {
                let row = connection
                    .query_one(
                        "select j.status, r.status from agent_jobs j join runs r on r.id = j.run_id
                         where j.id = $1",
                        &[&job],
                    )
                    .await?;
                assert_eq!(
                    (row.get::<_, String>(0), row.get::<_, String>(1)),
                    (job_status.to_string(), run_status.to_string()),
                    "job {job} and run {run} must be left alone"
                );
            }

            // Only the job no runtime ever held is refunded, with its slot.
            assert_eq!(
                refunds(&*connection, project).await?,
                vec![(
                    Some(format!("managed-ai-refund:{}", fixture.prompt_id)),
                    Some(SPACE_DELETED_REASON.to_string())
                )]
            );
            assert_eq!(
                prompt_metadata(pool, &fixture.prompt_id).await?["managedAiUsed"],
                json!(false)
            );

            let notices = cancellation_notices(&*connection, chat).await?;
            assert_eq!(notices.len(), 1);
            assert_eq!(notices[0].0, SPACE_DELETED_NOTICE);
            assert_eq!(notices[0].1["details"]["stopRequested"], json!(true));
            assert_eq!(notices[0].1["details"]["jobCount"], json!(3));
            let notices = cancellation_notices(&*connection, plan_chat).await?;
            assert_eq!(notices.len(), 1);
            assert_eq!(
                notices[0].1["details"]["suppressedPlanGroupIds"],
                json!([group])
            );
            {
                let mut connection = pool.get().await?;
                let transaction = connection.transaction().await?;
                assert!(crate::multi_agent_plan::plan_group_was_stopped(
                    &transaction,
                    project,
                    plan_chat,
                    &group.to_string()
                )
                .await
                .map_err(api_error)?);
                transaction.rollback().await?;
            }

            for entry in &queued_entries {
                let row = connection
                    .query_one(
                        "select status, error_message from conversation_send_queue where id = $1",
                        &[entry],
                    )
                    .await?;
                assert_eq!(
                    (row.get::<_, String>(0), row.get::<_, Option<String>>(1)),
                    ("canceled".to_string(), Some(SPACE_DELETED_REASON.into()))
                );
            }
            let dispatched_status: String = connection
                .query_one(
                    "select status from conversation_send_queue where id = $1",
                    &[&dispatched_entry],
                )
                .await?
                .get(0);
            assert_eq!(dispatched_status, "dispatched");

            let automation_rows = connection
                .query(
                    "select status, next_run_at = '2100-01-01T00:00:00Z' from automations
                     where id = any($1) order by array_position($1, id)",
                    &[&automations],
                )
                .await?;
            let automation_states: Vec<(String, bool)> = automation_rows
                .iter()
                .map(|row| (row.get(0), row.get(1)))
                .collect();
            assert_eq!(
                automation_states,
                vec![("paused".to_string(), true), ("paused".to_string(), true)]
            );

            // A repeat delete by a person cannot see the space. The
            // service-role repeat still succeeds and changes nothing more.
            assert_eq!(
                delete_space(&state, project, &token).await?,
                StatusCode::NOT_FOUND
            );
            assert_eq!(
                delete_space(&state, project, "service-role-token").await?,
                StatusCode::NO_CONTENT
            );
            assert_eq!(refunds(&*connection, project).await?.len(), 1);
            let notices: i64 = connection
                .query_one(
                    "select count(*) from conversation_messages
                     where project_id = $1 and metadata ->> 'kind' = 'run_cancellation'",
                    &[&project],
                )
                .await?
                .get(0);
            assert_eq!(notices, 2);
            Ok(())
        })
        .await
    }

    #[tokio::test]
    async fn late_work_in_a_deleted_space_is_canceled_and_live_spaces_are_left_alone(
    ) -> anyhow::Result<()> {
        let Some(fixture) = seed_reserved_managed_ai_prompt("deleted-space-late-work").await?
        else {
            eprintln!("skipping deleted space late work test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        with_seeded_space(&fixture, &[], async {
            let pool = &fixture.pool;
            let project = fixture.project_id;
            let job_status = |job: Uuid| async move {
                anyhow::Ok(
                    pool.get()
                        .await?
                        .query_one("select status from agent_jobs where id = $1", &[&job])
                        .await?
                        .get::<_, String>(0),
                )
            };

            let untouched = cancel_deleted_project_work(&fixture.state, project).await?;
            assert!(untouched.is_empty(), "a live space keeps its work");
            assert_eq!(job_status(fixture.job_id).await?, "queued");

            // The dispatch committed its job after the space's tombstone, and
            // a stop then requeued another job a runtime had held.
            let (requeued, requeued_run) = {
                let connection = pool.get().await?;
                connection
                    .execute(
                        "update projects set status = 'deleted' where id = $1",
                        &[&project],
                    )
                    .await?;
                insert_job(
                    &*connection,
                    project,
                    None,
                    "queued",
                    1,
                    "in_progress",
                    json!({}),
                    None,
                )
                .await?
            };

            let canceled = cancel_deleted_project_work(&fixture.state, project).await?;
            let mut canceled_jobs = canceled.canceled_job_ids.clone();
            canceled_jobs.sort();
            let mut expected_jobs = vec![fixture.job_id, requeued];
            expected_jobs.sort();
            assert_eq!(canceled_jobs, expected_jobs);
            let mut canceled_runs = canceled.canceled_run_ids.clone();
            canceled_runs.sort();
            let mut expected_runs = vec![fixture.run_id, requeued_run];
            expected_runs.sort();
            assert_eq!(canceled_runs, expected_runs);
            assert_eq!(canceled.refunded_org_ids, BTreeSet::from([fixture.org_id]));
            assert_eq!(job_status(fixture.job_id).await?, "canceled");
            assert_eq!(job_status(requeued).await?, "canceled");
            let connection = pool.get().await?;
            assert_eq!(
                refunds(&*connection, project).await?,
                vec![(
                    Some(format!("managed-ai-refund:{}", fixture.prompt_id)),
                    Some(SPACE_DELETED_REASON.to_string())
                )]
            );

            let repeat = cancel_deleted_project_work(&fixture.state, project).await?;
            assert!(repeat.is_empty(), "nothing is left to cancel: {repeat:?}");
            assert_eq!(refunds(&*connection, project).await?.len(), 1);
            Ok(())
        })
        .await
    }

    /// A delete Postgres ends as one side of a deadlock runs once more: here
    /// a steer, which locks a conversation's jobs in creation order, holds
    /// the space's last job in id order and then reaches for its first,
    /// which the delete, locking in id order, already holds. The delete
    /// waited first, so it is the side Postgres ends; it then waits for the
    /// steer and deletes the space with all of its work canceled.
    #[tokio::test]
    async fn a_delete_that_deadlocks_on_the_spaces_jobs_runs_once_more() -> anyhow::Result<()> {
        let Some(fixture) = seed_reserved_managed_ai_prompt("space-delete-deadlock").await? else {
            eprintln!("skipping space delete deadlock test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        with_seeded_space(&fixture, &[], async {
            let pool = &fixture.pool;
            let project = fixture.project_id;
            let mut jobs = vec![fixture.job_id];
            {
                let connection = pool.get().await?;
                for _ in 0..2 {
                    let (job, _) = insert_job(
                        &*connection,
                        project,
                        None,
                        "leased",
                        1,
                        "in_progress",
                        json!({}),
                        None,
                    )
                    .await?;
                    jobs.push(job);
                }
            }
            jobs.sort();
            let (first, last) = (jobs[0], jobs[2]);
            // The space's machine is gone already, so the stop the delete
            // starts has nothing to do while the fixture is cleaned up.
            pool.get()
                .await?
                .execute(
                    "update runtimes set status = 'stopped', active_lease_id = null
                     where project_id = $1",
                    &[&project],
                )
                .await?;

            let observer = pool.get().await?;
            let mut steer_connection = pool.get().await?;
            let steer = steer_connection.transaction().await?;
            let steer_pid: i32 = steer
                .query_one("select pg_backend_pid()", &[])
                .await?
                .get(0);
            steer
                .query_one(
                    "select id from agent_jobs where id = $1 for update",
                    &[&last],
                )
                .await?;

            let state = build_test_state(pool.clone(), fixture.config.clone());
            let delete = crate::tests::spawn_aborting({
                let state = state.clone();
                async move { delete_space(&state, project, "service-role-token").await }
            });
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    let blocked: i64 = observer
                        .query_one(
                            "select count(*) from pg_stat_activity
                             where $1 = any(pg_blocking_pids(pid))
                               and query like '%from agent_jobs%for update%'",
                            &[&steer_pid],
                        )
                        .await?
                        .get(0);
                    if blocked > 0 {
                        return anyhow::Ok(());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                }
            })
            .await
            .map_err(|_| anyhow::anyhow!("the delete never waited on the steer"))??;
            drop(observer);
            // Postgres checks a lock wait for a deadlock once, a second into
            // it, and ends the wait whose check finds one: the delete's,
            // which began half a second before the steer's.
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            steer
                .query_one(
                    "select id from agent_jobs where id = $1 for update",
                    &[&first],
                )
                .await
                .map_err(|error| {
                    anyhow::anyhow!("the steer, not the delete, was ended: {error:?}")
                })?;
            steer.commit().await?;
            drop(steer_connection);

            assert_eq!(delete.await??, StatusCode::NO_CONTENT);
            let connection = pool.get().await?;
            let status: String = connection
                .query_one("select status from projects where id = $1", &[&project])
                .await?
                .get(0);
            assert_eq!(status, "deleted");
            let job_statuses: Vec<String> = connection
                .query("select status from agent_jobs where id = any($1)", &[&jobs])
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect();
            assert_eq!(job_statuses, vec!["canceled".to_string(); 3]);
            Ok(())
        })
        .await
    }
}
