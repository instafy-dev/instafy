//! A Stop in a conversation beside another writer, on the migrated database.
//!
//! A Stop locks its jobs and cancels them, which expires their questions,
//! then locks its conversation and, in a thread, the thread's root. It gives
//! back the managed-AI reserve of a turn Instafy started by itself that left
//! the person nothing, which locks the org's balance, writes its notice into
//! the conversation and pauses the conversation's goal. A dispatch locks its
//! conversation `for update`, then reserves the org's credit; an answer
//! locks its question, then its conversation; a message's writer inserts it,
//! then updates its conversation. Each test holds the other writer once it
//! took its first lock, starts the Stop, lets the writer go, and needs both
//! to finish:
//!
//! - a managed-AI dispatch into the root of the stopped retry's thread: the
//!   Stop locks the root before the org's balance, not only once its notice
//!   reaches the root. Nothing it did before touched the root: a thread's
//!   run records no activity row, and the run names the thread.
//! - a managed-AI dispatch into the thread: the Stop locks the thread before
//!   the root, as the dispatch's message updates them. The old code passes
//!   it too, since the Stop's second rewrite of the stopped run rechecks the
//!   run's key, which waited for the thread before the give-back; only its
//!   goal pause's rare clash with the dispatch's runtime alert, the last
//!   test's deadlock, can fail it there.
//! - an answer to the stopped turn's question: the Stop expires the question
//!   before it locks the conversation, so it never waits for the question
//!   while it holds the conversation.
//! - a runtime alert, held between its insert and its conversation's update:
//!   the goal pause takes the conversation `for no key update`, the lock the
//!   Stop already holds, so the Stop never waits for the alert's insert while
//!   the alert's update waits for the Stop.

use std::time::Duration;

use serde_json::json;
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::config::PgPool;
use crate::system_turns::SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON;
use crate::tests::spawn_aborting;
use crate::tests_lock_waits::{
    controller_error, own_connection, reserves_besides, run_messages, seen_waited_for, would_wait,
    DispatchFence, HeldRunMessage,
};
use crate::tests_managed_ai_refund::{
    ledger_metadata_by_key, ledger_rows, seed_reserved_managed_ai_prompt, ReservedManagedAiPrompt,
};

/// How long each side may take to finish once nothing holds it.
const FINISH_WITHIN: Duration = Duration::from_secs(20);

/// The notice a Stop of one run writes.
const STOPPED_ONE_RUN: &str = "Stopped this run.";

/// Runs `test`, then removes the fixture's org, whose cascade takes the
/// project, its conversations and their runs, and the fixture's users,
/// whether the test returns or panics.
async fn on_the_fixtures_org(
    fixture: &ReservedManagedAiPrompt,
    test: impl std::future::Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<()> {
    use futures_util::FutureExt;

    let outcome = std::panic::AssertUnwindSafe(test).catch_unwind().await;
    let cleanup = fixture.cleanup().await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => {
            if let Err(error) = cleanup {
                eprintln!(
                    "[runtime-controller tests] fixture cleanup failed after a panic: {error:#}"
                );
            }
            std::panic::resume_unwind(panic)
        }
    }
}

/// Moves the fixture's managed-AI turn into a new thread of its conversation
/// and stamps it as an automatic retry, a turn Instafy started by itself, so
/// stopping it gives its reserve back. Returns the thread and its root.
async fn retry_in_a_thread(fixture: &ReservedManagedAiPrompt) -> anyhow::Result<(Uuid, Uuid)> {
    let thread = Uuid::new_v4();
    let connection = fixture.pool.get().await?;
    let root: Uuid = connection
        .query_one(
            "insert into conversations (
                 id, project_id, created_by, visibility,
                 parent_conversation_id, root_conversation_id, thread_kind
             )
             select $1, project_id, $2, 'public', id, id, 'thread'
             from conversations
             where id = (select conversation_id from agent_jobs where id = $3)
             returning root_conversation_id",
            &[&thread, &fixture.owner_user_id, &fixture.job_id],
        )
        .await?
        .get(0);
    connection
        .execute(
            "update agent_jobs
             set conversation_id = $2,
                 payload = jsonb_set(
                     payload || jsonb_build_object('conversation_id', $3::text),
                     '{metadata,automaticRetry}',
                     '{\"version\": 1}'::jsonb,
                     true
                 )
             where id = $1",
            &[&fixture.job_id, &thread, &thread.to_string()],
        )
        .await?;
    connection
        .execute(
            "update runs set conversation_id = $2 where id = $1",
            &[&fixture.run_id, &thread],
        )
        .await?;
    connection
        .execute(
            "update prompts set conversation_id = $2 where id = $1",
            &[&fixture.prompt_id, &thread],
        )
        .await?;
    Ok((thread, root))
}

/// Stops `job` in `conversation` as `owner`, on a connection of its own, and
/// commits, as the Stop route does.
async fn stop(
    state: crate::AppState,
    owner: Uuid,
    conversation: Uuid,
    job: Uuid,
) -> anyhow::Result<()> {
    let mut connection = state.pool.get().await?;
    let transaction = connection.transaction().await?;
    let context = RequestContext {
        user_id: Some(owner),
        is_service_role: false,
        scoped_claims: None,
    };
    super::stop_jobs_in_transaction(&state.config, &transaction, &context, conversation, &[job])
        .await
        .map_err(|error| controller_error("the Stop", error))?;
    transaction.commit().await?;
    Ok(())
}

/// How many notices of a Stop of one run `conversation` keeps.
async fn stop_notices(pool: &PgPool, conversation: Uuid) -> anyhow::Result<i64> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select count(*) from conversation_messages
              where conversation_id = $1 and content = $2",
            &[&conversation, &STOPPED_ONE_RUN],
        )
        .await?
        .get(0))
}

/// Stops the automatic retry in its thread while a managed-AI dispatch into
/// the thread's root, or into the thread itself, is held once it locked that
/// conversation and before it reserves. Both must finish, and the Stop must
/// not hold the org's balance while it waits for the dispatch.
async fn stop_beside_a_dispatch(label: &str, into_root: bool) -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt(label).await? else {
        eprintln!("skipping the Stop beside a dispatch: TEST_DATABASE_URL not set");
        return Ok(());
    };
    on_the_fixtures_org(&fixture, async {
        let pool = &fixture.pool;
        let (thread, root) = retry_in_a_thread(&fixture).await?;

        // The person sends another managed-AI prompt. The dispatch locks its
        // conversation, then waits at its fence, before it reserves the org's
        // credit.
        let fence = DispatchFence::hold(if into_root { root } else { thread }).await?;
        let (dispatching, dispatch_pid) = fence
            .held_dispatch(
                &fixture.state,
                fixture.project_id,
                fixture.owner_user_id,
                "and the green one?",
            )
            .await?;

        let state = fixture.state.clone();
        let (owner, job) = (fixture.owner_user_id, fixture.job_id);
        let stopping = spawn_aborting(async move { stop(state, owner, thread, job).await });
        anyhow::ensure!(
            seen_waited_for(pool, &stopping, dispatch_pid).await?,
            "the Stop never waited for the dispatch's conversation"
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
        let stopped = tokio::time::timeout(FINISH_WITHIN, stopping).await?;

        assert!(
            !balance_held,
            "the Stop waits for the conversation while it holds the org's balance"
        );
        assert_eq!(dispatched??.status, "queued", "the prompt is queued");
        assert_eq!(
            reserves_besides(pool, fixture.project_id, fixture.prompt_id).await?,
            1,
            "the dispatch reserves the org's credit past its fence"
        );
        stopped??;
        let refund_key = format!("managed-ai-refund:{}", fixture.prompt_id);
        assert!(
            ledger_rows(pool, &fixture.project_id)
                .await?
                .iter()
                .any(|(_, _, key)| key.as_deref() == Some(refund_key.as_str())),
            "the stopped retry's reserve is given back"
        );
        assert_eq!(
            ledger_metadata_by_key(pool, &fixture.project_id, &refund_key).await?["refundReason"],
            json!(SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON),
            "the Stop gives the reserve back, as a turn that left nothing"
        );
        assert_eq!(
            stop_notices(pool, thread).await?,
            1,
            "the Stop's notice is in the thread"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_stop_in_a_thread_and_a_managed_ai_dispatch_into_its_root_both_finish(
) -> anyhow::Result<()> {
    stop_beside_a_dispatch("stop-beside-root-dispatch", true).await
}

#[tokio::test]
async fn a_stop_in_a_thread_and_a_managed_ai_dispatch_into_the_thread_both_finish(
) -> anyhow::Result<()> {
    stop_beside_a_dispatch("stop-beside-thread-dispatch", false).await
}

#[tokio::test]
async fn a_stop_and_an_answer_to_its_turns_question_both_finish() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("stop-beside-answer").await? else {
        eprintln!("skipping the Stop beside an answer: TEST_DATABASE_URL not set");
        return Ok(());
    };
    on_the_fixtures_org(&fixture, async {
        let pool = &fixture.pool;
        let (project, owner, job) = (fixture.project_id, fixture.owner_user_id, fixture.job_id);
        // The turn asked the person a question.
        let question = Uuid::new_v4();
        let chat: Uuid = pool
            .get()
            .await?
            .query_one(
                "insert into agent_user_input_requests (
                     id, requested_user_id, project_id, conversation_id, job_id,
                     lease_attempt, group_id, agent_handle, questions, continuation_note
                 )
                 select $1, $2, project_id, conversation_id, id,
                        1, gen_random_uuid(), 'scribe', '[]', 'Go on with the answer.'
                 from agent_jobs where id = $3
                 returning conversation_id",
                &[&question, &owner, &job],
            )
            .await?
            .get(0);

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
        let stopping = spawn_aborting(async move { stop(state, owner, chat, job).await });
        anyhow::ensure!(
            seen_waited_for(pool, &stopping, answer_pid).await?,
            "the Stop never waited for the answer's question"
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
        let stopped = tokio::time::timeout(FINISH_WITHIN, stopping).await?;

        assert!(
            !chat_held,
            "the Stop waits for the question while it holds the conversation"
        );
        answered?;
        stopped??;
        let status: String = pool
            .get()
            .await?
            .query_one(
                "select status from agent_user_input_requests where id = $1",
                &[&question],
            )
            .await?
            .get(0);
        assert_eq!(status, "expired", "the stopped turn never resumes");
        assert_eq!(
            stop_notices(pool, chat).await?,
            1,
            "the Stop's notice is in the conversation"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_stop_and_a_runtime_alert_into_its_conversation_both_finish() -> anyhow::Result<()> {
    let Some(fixture) = seed_reserved_managed_ai_prompt("stop-beside-run-message").await? else {
        eprintln!("skipping the Stop beside a runtime alert: TEST_DATABASE_URL not set");
        return Ok(());
    };
    on_the_fixtures_org(&fixture, async {
        let pool = &fixture.pool;
        let (owner, job) = (fixture.owner_user_id, fixture.job_id);
        let chat: Uuid = pool
            .get()
            .await?
            .query_one(
                "select conversation_id from agent_jobs where id = $1",
                &[&job],
            )
            .await?
            .get(0);
        // A dispatch that committed writes its runtime alert into the
        // conversation, held between the insert and the conversation's update.
        let message = HeldRunMessage::insert(
            fixture.project_id,
            chat,
            fixture.run_id,
            Some(fixture.prompt_id),
        )
        .await?;

        let state = fixture.state.clone();
        let stopping = spawn_aborting(async move { stop(state, owner, chat, job).await });
        let waited = seen_waited_for(pool, &stopping, message.pid).await?;
        let written = tokio::time::timeout(FINISH_WITHIN, message.finish()).await?;
        let stopped = tokio::time::timeout(FINISH_WITHIN, stopping).await?;

        assert!(
            !waited,
            "the Stop waits for the alert while it holds the conversation"
        );
        written?;
        stopped??;
        assert_eq!(run_messages(pool, chat).await?, 1, "the alert is kept");
        assert_eq!(
            stop_notices(pool, chat).await?,
            1,
            "the Stop's notice is in the conversation"
        );
        Ok(())
    })
    .await
}
