//! A deleted space's cancel beside other writers, on the migrated database.
//!
//! The cancel locks the space's live jobs, expires its worker questions,
//! gives back the managed-AI reserve of a queued job no runtime held, and
//! writes a notice into each conversation those jobs ran in. Each test holds
//! another writer partway, runs the cancel beside it, lets it go, and needs
//! both to finish:
//!
//! - teammates writing into two threads of one root, each held between the
//!   thread and the root: the cancel locks both threads before the root;
//! - an answer to a worker question, held once it locked the question: the
//!   cancel expires the space's questions before it locks a conversation, as
//!   the answer locks its question before its conversation;
//! - a plan dispatching a worker, held once it locked the conversation: the
//!   cancel's locks on the live jobs leave their keys free, so the worker,
//!   inserted with its lead as its parent, goes in;
//! - a managed-AI dispatch, held once it locked the conversation and before
//!   it reserves: the delete locks the conversation before the org's balance,
//!   as the dispatch does;
//! - a message naming one of the space's open runs, held between its insert
//!   and its conversation's update: the cancel closes the run after it locked
//!   the conversation, with a lock that lets the message's key-share lock on
//!   the run be.

use std::time::Duration;

use axum::http::StatusCode;
use serde_json::json;
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use super::tests::{cancellation_notices, delete_space, insert_job, refunds, with_seeded_space};
use super::{cancel_deleted_project_work, SPACE_DELETED_REASON};
use crate::config::PgPool;
use crate::tests::spawn_aborting;
use crate::tests_lock_waits::{
    beside_thread_writers, own_connection, reserves_besides, run_messages, seen_waited_for,
    would_wait, DispatchFence, HeldRunMessage,
};
use crate::tests_managed_ai_refund::seed_reserved_managed_ai_prompt;

/// How long each side may take to finish once nothing holds it.
const FINISH_WITHIN: Duration = Duration::from_secs(20);

/// The conversation `job` runs in.
async fn conversation_of(pool: &PgPool, job: Uuid) -> anyhow::Result<Uuid> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select conversation_id from agent_jobs where id = $1",
            &[&job],
        )
        .await?
        .get(0))
}

/// Marks the space deleted, as a delete that committed before the work came
/// in, so [`cancel_deleted_project_work`] cancels its work.
async fn mark_deleted(pool: &PgPool, project_id: Uuid) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "update projects set status = 'deleted' where id = $1",
            &[&project_id],
        )
        .await?;
    Ok(())
}

/// How many of `project`'s jobs are queued or leased.
async fn live_jobs(pool: &PgPool, project: Uuid) -> anyhow::Result<i64> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select count(*) from agent_jobs
              where project_id = $1 and status in ('queued', 'leased')",
            &[&project],
        )
        .await?
        .get(0))
}

async fn status_of(pool: &PgPool, table: &str, id: Uuid) -> anyhow::Result<String> {
    Ok(pool
        .get()
        .await?
        .query_one(
            format!("select status from {table} where id = $1").as_str(),
            &[&id],
        )
        .await?
        .get(0))
}

#[tokio::test]
async fn a_deleted_spaces_cancel_and_teammates_writing_into_its_threads_all_finish(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("space-cancel-beside-threads").await?
    else {
        eprintln!("skipping the space cancel beside thread writers: TEST_DATABASE_URL not set");
        return Ok(());
    };
    with_seeded_space(&fixture, &[], async {
        let pool = &fixture.pool;
        let project = fixture.project_id;
        let root = conversation_of(pool, fixture.job_id).await?;
        let threads = [Uuid::new_v4(), Uuid::new_v4()];
        let mut jobs = vec![fixture.job_id];
        {
            let connection = pool.get().await?;
            for thread in threads {
                connection
                    .execute(
                        "insert into conversations (
                             id, project_id, created_by, visibility,
                             parent_conversation_id, root_conversation_id, thread_kind
                         ) values ($1, $2, $3, 'public', $4, $4, 'thread')",
                        &[&thread, &project, &fixture.owner_user_id, &root],
                    )
                    .await?;
                let (job, _) = insert_job(
                    &*connection,
                    project,
                    Some(thread),
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
        mark_deleted(pool, project).await?;

        let state = fixture.state.clone();
        let canceled = beside_thread_writers(pool, project, root, threads, async move {
            cancel_deleted_project_work(&state, project).await
        })
        .await?;
        let mut canceled_jobs = canceled.canceled_job_ids;
        canceled_jobs.sort();
        jobs.sort();
        assert_eq!(canceled_jobs, jobs, "the root's job and each thread's");
        let connection = pool.get().await?;
        for conversation in [root, threads[0], threads[1]] {
            assert_eq!(
                cancellation_notices(&*connection, conversation)
                    .await?
                    .len(),
                1,
                "the cancel says why in {conversation}"
            );
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_deleted_spaces_cancel_and_an_answer_to_a_worker_question_both_finish(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("space-cancel-beside-answer").await? else {
        eprintln!("skipping the space cancel beside an answer: TEST_DATABASE_URL not set");
        return Ok(());
    };
    with_seeded_space(&fixture, &[], async {
        let pool = &fixture.pool;
        let project = fixture.project_id;
        let owner = fixture.owner_user_id;
        let chat = conversation_of(pool, fixture.job_id).await?;
        // A worker of a plan in the conversation finished and left the
        // person a question.
        let question = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            let group = Uuid::new_v4();
            let (worker, _) = insert_job(
                &*connection,
                project,
                Some(chat),
                "completed",
                1,
                "success",
                json!({}),
                Some(group),
            )
            .await?;
            connection
                .execute(
                    "insert into agent_user_input_requests (
                         id, requested_user_id, project_id, conversation_id, job_id,
                         lease_attempt, group_id, agent_handle, questions, continuation_note
                     ) values ($1, $2, $3, $4, $5, 1, $6, 'scribe', '[]', 'Go on with the answer.')",
                    &[&question, &owner, &project, &chat, &worker, &group],
                )
                .await?;
        }
        mark_deleted(pool, project).await?;

        // The person answers it. The answer locks the question first.
        let (mut answering, answer_driver, answer_pid) = own_connection().await?;
        let answer = answering.transaction().await?;
        answer
            .query_one(
                "select status from agent_user_input_requests where id = $1 for update",
                &[&question],
            )
            .await?;

        let state = fixture.state.clone();
        let canceling =
            spawn_aborting(async move { cancel_deleted_project_work(&state, project).await });
        anyhow::ensure!(
            seen_waited_for(pool, &canceling, answer_pid).await?,
            "the cancel never waited for the answer's question"
        );
        let chat_held = would_wait(pool, "conversations", "id", chat, "share").await?;

        // Then it records the answer, marks the question answered and
        // updates the conversation, the statements of `answer_request` in
        // its order.
        let answered = async {
            let message = Uuid::new_v4();
            answer
                .execute(
                    "insert into conversation_messages (
                         id, project_id, conversation_id, role, content, metadata, created_by
                     ) values ($1, $2, $3, 'user', 'Blue.', $4, $5)",
                    &[
                        &message,
                        &project,
                        &chat,
                        &PgJson(json!({ "userInputRequestId": question })),
                        &owner,
                    ],
                )
                .await?;
            answer
                .execute(
                    "update agent_user_input_requests
                     set status = 'answered', answers = '{}', answered_by = $3,
                         answer_message_id = $2, answered_at = now(), updated_at = now()
                     where id = $1",
                    &[&question, &message, &owner],
                )
                .await?;
            answer
                .execute(
                    "update conversations
                     set updated_at = now(), last_message_id = $2, last_message_at = now()
                     where id = $1",
                    &[&chat, &message],
                )
                .await?;
            answer.commit().await?;
            anyhow::Ok(())
        };
        let answered = tokio::time::timeout(FINISH_WITHIN, answered).await?;
        drop(answering);
        let _ = answer_driver.await;
        let canceled = tokio::time::timeout(FINISH_WITHIN, canceling).await?;

        assert!(
            !chat_held,
            "the cancel waits for the question while it holds the conversation"
        );
        answered?;
        let canceled = canceled??;
        assert_eq!(canceled.expired_user_input_requests, 1);
        assert_eq!(
            status_of(pool, "agent_user_input_requests", question).await?,
            "expired",
            "a deleted space never resumes the answered worker"
        );
        assert_eq!(
            cancellation_notices(&*pool.get().await?, chat).await?.len(),
            1
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_deleted_spaces_cancel_and_a_worker_dispatched_under_its_lead_both_finish(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("space-cancel-beside-worker").await? else {
        eprintln!("skipping the space cancel beside a worker dispatch: TEST_DATABASE_URL not set");
        return Ok(());
    };
    with_seeded_space(&fixture, &[], async {
        let pool = &fixture.pool;
        let project = fixture.project_id;
        let chat = conversation_of(pool, fixture.job_id).await?;
        let group = Uuid::new_v4();
        let (lead, _) = insert_job(
            &*pool.get().await?,
            project,
            Some(chat),
            "leased",
            1,
            "in_progress",
            json!({}),
            Some(group),
        )
        .await?;
        mark_deleted(pool, project).await?;

        // The lead's plan dispatches a worker into the conversation. The
        // dispatch locks the conversation first.
        let (mut dispatching, dispatch_driver, dispatch_pid) = own_connection().await?;
        let dispatch = dispatching.transaction().await?;
        dispatch
            .query_one(
                "select id from conversations where id = $1 for update",
                &[&chat],
            )
            .await?;

        let state = fixture.state.clone();
        let canceling =
            spawn_aborting(async move { cancel_deleted_project_work(&state, project).await });
        anyhow::ensure!(
            seen_waited_for(pool, &canceling, dispatch_pid).await?,
            "the cancel never waited for the dispatch's conversation"
        );
        let lead_key_held = would_wait(pool, "agent_jobs", "id", lead, "key share").await?;

        // Then it inserts the worker with the lead as its parent, as
        // `enqueue_agent_job_record` does.
        let worker = Uuid::new_v4();
        let dispatched = async {
            dispatch
                .execute(
                    "insert into agent_jobs (
                         id, project_id, conversation_id, status, payload, plan_group_id,
                         parent_job_id
                     ) values ($1, $2, $3, 'queued', '{}', $4, $5)",
                    &[&worker, &project, &chat, &group, &lead],
                )
                .await?;
            dispatch.commit().await?;
            anyhow::Ok(())
        };
        let dispatched = tokio::time::timeout(FINISH_WITHIN, dispatched).await?;
        drop(dispatching);
        let _ = dispatch_driver.await;
        let canceled = tokio::time::timeout(FINISH_WITHIN, canceling).await?;

        assert!(
            !lead_key_held,
            "the cancel locks the lead job against a worker inserted under it"
        );
        dispatched?;
        assert!(canceled??.canceled_job_ids.contains(&lead));
        // The worker came in after the cancel locked the space's jobs, so the
        // next cancel, after a stop or the idle sweep's, ends it.
        cancel_deleted_project_work(&fixture.state, project).await?;
        assert_eq!(status_of(pool, "agent_jobs", lead).await?, "canceled");
        assert_eq!(status_of(pool, "agent_jobs", worker).await?, "canceled");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn deleting_a_space_and_a_managed_ai_dispatch_into_its_conversation_both_finish(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("space-delete-beside-dispatch").await?
    else {
        eprintln!("skipping the space delete beside a dispatch: TEST_DATABASE_URL not set");
        return Ok(());
    };
    with_seeded_space(&fixture, &[], async {
        let pool = &fixture.pool;
        let project = fixture.project_id;
        let chat = conversation_of(pool, fixture.job_id).await?;
        // The space's machine is gone already, so the stop the delete starts
        // has nothing to do while the fixture is cleaned up.
        pool.get()
            .await?
            .execute(
                "update runtimes set status = 'stopped', active_lease_id = null
                 where project_id = $1",
                &[&project],
            )
            .await?;

        // The person sends another managed-AI prompt there. The dispatch
        // locks the conversation, then waits at its fence, before it
        // reserves the org's credit.
        let fence = DispatchFence::hold(chat).await?;
        let (dispatching, dispatch_pid) = fence
            .held_dispatch(
                &fixture.state,
                project,
                fixture.owner_user_id,
                "and the green one?",
            )
            .await?;

        let state = fixture.state.clone();
        let deleting =
            spawn_aborting(
                async move { delete_space(&state, project, "service-role-token").await },
            );
        anyhow::ensure!(
            seen_waited_for(pool, &deleting, dispatch_pid).await?,
            "the delete never waited for the dispatch's conversation"
        );
        let balance_held = would_wait(
            pool,
            "org_credit_balances",
            "org_id",
            fixture.org_id,
            "share",
        )
        .await?;
        fence.release().await?;
        let dispatched = tokio::time::timeout(FINISH_WITHIN, dispatching).await?;
        let deleted = tokio::time::timeout(FINISH_WITHIN, deleting).await?;

        assert!(
            !balance_held,
            "the delete waits for the conversation while it holds the org's balance"
        );
        assert_eq!(dispatched??.status, "queued", "the prompt is queued");
        assert_eq!(
            reserves_besides(pool, project, fixture.prompt_id).await?,
            1,
            "the dispatch reserves the org's credit past its fence"
        );
        assert_eq!(deleted??, StatusCode::NO_CONTENT);
        // The prompt reached the space after the delete locked its jobs, so
        // the stop the delete hands the space to cancels it. Waited for, so
        // that task is done before the fixture is cleaned up.
        let deadline = tokio::time::Instant::now() + FINISH_WITHIN;
        while live_jobs(pool, project).await? > 0 {
            anyhow::ensure!(
                tokio::time::Instant::now() < deadline,
                "the delete's stop never canceled the prompt that came after the delete"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let connection = pool.get().await?;
        let refund = (
            Some(format!("managed-ai-refund:{}", fixture.prompt_id)),
            Some(SPACE_DELETED_REASON.to_string()),
        );
        assert!(
            refunds(&*connection, project).await?.contains(&refund),
            "the queued prompt's reserve is given back"
        );
        assert_eq!(
            cancellation_notices(&*connection, chat).await?.len(),
            2,
            "the delete's notice and its stop's"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_deleted_spaces_cancel_and_a_message_naming_one_of_its_runs_both_finish(
) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("space-cancel-beside-run-message").await?
    else {
        eprintln!("skipping the space cancel beside a run's message: TEST_DATABASE_URL not set");
        return Ok(());
    };
    with_seeded_space(&fixture, &[], async {
        let pool = &fixture.pool;
        let project = fixture.project_id;
        let chat = conversation_of(pool, fixture.job_id).await?;
        // A run still open with no live job behind it, as a dispatch's is
        // when it commits after the cancel locked the space's jobs. The cancel
        // closes it once it holds the conversation.
        let open_run = Uuid::new_v4();
        pool.get()
            .await?
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status)
                 values ($1, $2, $3, 'prompt', 'queued')",
                &[&open_run, &project, &chat],
            )
            .await?;
        mark_deleted(pool, project).await?;

        // The run's message is in and waits to update the conversation, as
        // that dispatch's runtime alert would.
        let message = HeldRunMessage::insert(project, chat, open_run, None).await?;
        let state = fixture.state.clone();
        let canceling =
            spawn_aborting(async move { cancel_deleted_project_work(&state, project).await });
        let waited = seen_waited_for(pool, &canceling, message.pid).await?;
        let chat_held =
            waited && would_wait(pool, "conversations", "id", chat, "no key update").await?;
        anyhow::ensure!(
            !chat_held,
            "the cancel waits for the run's message while it holds the message's conversation"
        );
        message.finish().await?;
        let canceled = tokio::time::timeout(FINISH_WITHIN, canceling).await???;

        assert!(canceled.canceled_run_ids.contains(&open_run));
        assert_eq!(status_of(pool, "runs", open_run).await?, "canceled");
        assert_eq!(
            status_of(pool, "agent_jobs", fixture.job_id).await?,
            "canceled"
        );
        assert_eq!(
            run_messages(pool, chat).await?,
            1,
            "the run's message is kept"
        );
        let connection = pool.get().await?;
        assert_eq!(cancellation_notices(&*connection, chat).await?.len(), 1);
        Ok(())
    })
    .await
}
