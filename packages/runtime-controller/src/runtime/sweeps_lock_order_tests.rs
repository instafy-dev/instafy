//! A queued-job sweep beside other writers, on the migrated database.
//!
//! A sweep fails the queued jobs of several conversations in one transaction
//! and writes why into each job's conversation, after it gave back the
//! managed-AI reserve of a turn that left the person nothing. Writing into a
//! thread updates the thread, then its root. The first test runs the
//! requeued-job expiry over two threads of one root beside a teammate writing
//! into each thread, held between the thread and the root: the sweep locks
//! both threads before the root, so all three finish. The second runs it
//! beside a managed-AI dispatch into the expired job's thread, held after it
//! locked the thread and before it reserves: the sweep locks the thread
//! before it touches the org's balance, as the dispatch does, so both finish.
//! The third runs it beside a message naming the expired job's run and
//! prompt, held between its insert and its conversation's update, as a
//! dispatch's runtime alert writes one: the sweep gives the reserve back once
//! it holds the conversation, with locks on the run and the prompt that let
//! the message's key-share locks on them be.

use std::time::Duration;

use serde_json::json;
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::config::PgPool;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool, spawn_aborting,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tests_lock_waits::{
    beside_thread_writers, reserves_besides, run_messages, seen_waited_for, would_wait,
    DispatchFence, HeldRunMessage,
};

/// Requeued by a stop long enough ago for the expiry to fail it.
const REQUEUED_SECONDS_AGO: f64 = (super::REQUEUED_JOB_EXPIRY_SECONDS + 60) as f64;

/// Runs the requeued-job expiry once.
async fn expire_requeued_jobs(state: &crate::AppState) -> anyhow::Result<()> {
    super::expire_stale_requeued_jobs(state, &mut super::TickConnection::new(&state.pool)).await
}

/// How many of the expiry's failure messages `conversation` has.
async fn expiry_messages(pool: &PgPool, conversation: Uuid) -> anyhow::Result<i64> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select count(*) from conversation_messages
              where conversation_id = $1 and metadata ->> 'kind' = $2",
            &[&conversation, &super::INTERRUPTED_RUN_EXPIRED_CODE],
        )
        .await?
        .get(0))
}

async fn job_state(pool: &PgPool, job: Uuid) -> anyhow::Result<(String, Option<String>)> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select status, outcome from agent_jobs where id = $1",
            &[&job],
        )
        .await?;
    Ok((row.get(0), row.get(1)))
}

#[tokio::test]
async fn the_requeued_job_expiry_and_teammates_writing_into_its_threads_all_finish(
) -> anyhow::Result<()> {
    let label = "requeued-expiry-beside-thread-writers";
    let pool = require_origin_test_pool(label).await?;
    let state = build_test_state(
        pool.clone(),
        build_app_config(test_origin_private_key(), test_origin_public_key(), label),
    );
    let (project_id, owner) = (Uuid::new_v4(), Uuid::new_v4());
    let (root, threads) = (Uuid::new_v4(), [Uuid::new_v4(), Uuid::new_v4()]);
    let body_pool = pool.clone();
    let outcome = with_shared_db_fixture(
        SharedDbFixture {
            organizations: Vec::new(),
            projects: vec![project_id],
        },
        async move {
            let pool = body_pool;
            ensure_test_user(&pool, &owner).await?;
            let connection = pool.get().await?;
            // A space with no runtime, so nothing will run its requeued jobs.
            connection
                .execute(
                    "insert into projects (id, name, owner_user_id, project_type, status)
                     values ($1, $2, $3, 'customer', 'active')",
                    &[&project_id, &label, &owner],
                )
                .await?;
            connection
                .execute(
                    "insert into conversations (id, project_id, created_by, visibility)
                     values ($1, $2, $3, 'public')",
                    &[&root, &project_id, &owner],
                )
                .await?;
            let mut jobs = Vec::new();
            for thread in threads {
                connection
                    .execute(
                        "insert into conversations (
                             id, project_id, created_by, visibility,
                             parent_conversation_id, root_conversation_id, thread_kind
                         ) values ($1, $2, $3, 'public', $4, $4, 'thread')",
                        &[&thread, &project_id, &owner, &root],
                    )
                    .await?;
                let job = Uuid::new_v4();
                connection
                    .execute(
                        "insert into agent_jobs (
                             id, project_id, conversation_id, status, intent, lease_attempts,
                             payload
                         ) values ($1, $2, $3, 'queued', 'feature', 1, $4::jsonb
                             || jsonb_build_object(
                                 'requeuedAt', (now() - interval '1 second' * $5)::text
                             ))",
                        &[
                            &job,
                            &project_id,
                            &thread,
                            &PgJson(json!({ "user_id": owner, "conversation_id": thread })),
                            &REQUEUED_SECONDS_AGO,
                        ],
                    )
                    .await?;
                jobs.push(job);
            }
            drop(connection);

            let sweep_state = state.clone();
            beside_thread_writers(&pool, project_id, root, threads, async move {
                expire_requeued_jobs(&sweep_state).await
            })
            .await?;
            for job in jobs {
                assert_eq!(
                    job_state(&pool, job).await?,
                    ("failed".to_string(), Some("expired".to_string()))
                );
            }
            for thread in threads {
                assert_eq!(
                    expiry_messages(&pool, thread).await?,
                    1,
                    "the expiry says why in {thread}"
                );
            }
            Ok(())
        },
    )
    .await;
    let cleanup = pool
        .get()
        .await?
        .execute("delete from auth.users where id = $1", &[&owner])
        .await;
    outcome.and(cleanup.map(|_| ()).map_err(anyhow::Error::from))
}

#[tokio::test]
async fn the_requeued_job_expiry_and_a_managed_ai_dispatch_into_its_thread_both_finish(
) -> anyhow::Result<()> {
    use crate::tests_managed_ai_refund::{ledger_rows, seed_reserved_managed_ai_prompt};

    let Some(fixture) = seed_reserved_managed_ai_prompt("expiry-beside-dispatch").await? else {
        eprintln!("skipping the expiry beside a dispatch: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let fixture_org = SharedDbFixture {
        organizations: vec![fixture.org_id],
        projects: Vec::new(),
    };
    let outcome = with_shared_db_fixture(fixture_org, async {
        let pool = &fixture.pool;
        // The managed-AI job ran in a thread, a stop requeued it, and nothing
        // came back for it: the expiry fails it and gives its reserve back.
        // A thread's run records no activity row on the thread, so the
        // failure message is the first the sweep writes there.
        let conversation = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "update runtimes set status = 'stopped' where project_id = $1",
                    &[&fixture.project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into conversations (
                         id, project_id, created_by, visibility,
                         parent_conversation_id, root_conversation_id, thread_kind
                     )
                     select $1, project_id, $2, 'public', id, id, 'thread'
                     from conversations
                     where id = (select conversation_id from agent_jobs where id = $3)",
                    &[&conversation, &fixture.owner_user_id, &fixture.job_id],
                )
                .await?;
            connection
                .execute(
                    "update agent_jobs
                     set status = 'queued',
                         conversation_id = $3,
                         payload = payload || jsonb_build_object(
                             'conversation_id', $4::text,
                             'requeuedAt', (now() - interval '1 second' * $2)::text
                         )
                     where id = $1",
                    &[
                        &fixture.job_id,
                        &REQUEUED_SECONDS_AGO,
                        &conversation,
                        &conversation.to_string(),
                    ],
                )
                .await?;
            connection
                .execute(
                    "update runs set conversation_id = $2 where id = $1",
                    &[&fixture.run_id, &conversation],
                )
                .await?;
        }

        // Meanwhile the person sends another managed-AI prompt there. The
        // dispatch locks the thread, then waits at its fence, before it
        // reserves the org's credit.
        let fence = DispatchFence::hold(conversation).await?;
        let (dispatching, dispatch_pid) = fence
            .held_dispatch(
                &fixture.state,
                fixture.project_id,
                fixture.owner_user_id,
                "and the green one?",
            )
            .await?;

        let sweep_state = fixture.state.clone();
        let sweeping = spawn_aborting(async move { expire_requeued_jobs(&sweep_state).await });
        // Until the sweep waits for the dispatch's thread.
        anyhow::ensure!(
            seen_waited_for(pool, &sweeping, dispatch_pid).await?,
            "the sweep never waited for the dispatch's thread"
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
        let dispatched = tokio::time::timeout(Duration::from_secs(20), dispatching).await?;
        let swept = tokio::time::timeout(Duration::from_secs(20), sweeping).await?;

        assert!(
            !balance_held,
            "the sweep waits for the thread while it holds the org's balance"
        );
        let dispatched = dispatched??;
        assert_eq!(dispatched.status, "queued", "the second prompt is queued");
        assert_eq!(
            reserves_besides(pool, fixture.project_id, fixture.prompt_id).await?,
            1,
            "the dispatch reserves the org's credit past its fence"
        );
        swept??;
        assert_eq!(
            job_state(pool, fixture.job_id).await?,
            ("failed".to_string(), Some("expired".to_string()))
        );
        assert_eq!(expiry_messages(pool, conversation).await?, 1);
        let refund_key = format!("managed-ai-refund:{}", fixture.prompt_id);
        assert!(
            ledger_rows(pool, &fixture.project_id)
                .await?
                .iter()
                .any(|(_, _, key)| key.as_deref() == Some(refund_key.as_str())),
            "the expired prompt's reserve is given back"
        );
        Ok(())
    })
    .await;
    // Runs reference no space, so the org's cascade leaves them.
    let cleanup = async {
        fixture
            .pool
            .get()
            .await?
            .execute(
                "delete from runs where project_id = $1",
                &[&fixture.project_id],
            )
            .await?;
        fixture.cleanup().await
    }
    .await;
    outcome.and(cleanup)
}

#[tokio::test]
async fn the_requeued_job_expiry_and_a_message_naming_its_run_both_finish() -> anyhow::Result<()> {
    use crate::tests_managed_ai_refund::{ledger_rows, seed_reserved_managed_ai_prompt};

    let Some(fixture) = seed_reserved_managed_ai_prompt("expiry-beside-run-message").await? else {
        eprintln!("skipping the expiry beside a run's message: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let fixture_org = SharedDbFixture {
        organizations: vec![fixture.org_id],
        projects: Vec::new(),
    };
    let outcome = with_shared_db_fixture(fixture_org, async {
        let pool = &fixture.pool;
        // A stop requeued the managed-AI job and nothing came back for it, so
        // the expiry fails it and gives its reserve back.
        let conversation: Uuid = {
            let connection = pool.get().await?;
            connection
                .execute(
                    "update runtimes set status = 'stopped' where project_id = $1",
                    &[&fixture.project_id],
                )
                .await?;
            connection
                .query_one(
                    "update agent_jobs
                     set status = 'queued',
                         payload = payload || jsonb_build_object(
                             'requeuedAt', (now() - interval '1 second' * $2)::text
                         )
                     where id = $1
                     returning conversation_id",
                    &[&fixture.job_id, &REQUEUED_SECONDS_AGO],
                )
                .await?
                .get(0)
        };

        // A message naming the job's run and prompt is in and waits to update
        // the conversation.
        let message = HeldRunMessage::insert(
            fixture.project_id,
            conversation,
            fixture.run_id,
            Some(fixture.prompt_id),
        )
        .await?;
        let sweep_state = fixture.state.clone();
        let sweeping = spawn_aborting(async move { expire_requeued_jobs(&sweep_state).await });
        let waited = seen_waited_for(pool, &sweeping, message.pid).await?;
        let conversation_held = waited
            && would_wait(pool, "conversations", "id", conversation, "no key update").await?;
        anyhow::ensure!(
            !conversation_held,
            "the expiry waits for the run's message while it holds the message's conversation"
        );
        message.finish().await?;
        tokio::time::timeout(Duration::from_secs(20), sweeping).await???;

        assert_eq!(
            job_state(pool, fixture.job_id).await?,
            ("failed".to_string(), Some("expired".to_string()))
        );
        assert_eq!(expiry_messages(pool, conversation).await?, 1);
        assert_eq!(
            run_messages(pool, conversation).await?,
            1,
            "the run's message is kept"
        );
        let refund_key = format!("managed-ai-refund:{}", fixture.prompt_id);
        assert!(
            ledger_rows(pool, &fixture.project_id)
                .await?
                .iter()
                .any(|(_, _, key)| key.as_deref() == Some(refund_key.as_str())),
            "the expired prompt's reserve is given back"
        );
        Ok(())
    })
    .await;
    // Runs reference no space, so the org's cascade leaves them.
    let cleanup = async {
        fixture
            .pool
            .get()
            .await?
            .execute(
                "delete from runs where project_id = $1",
                &[&fixture.project_id],
            )
            .await?;
        fixture.cleanup().await
    }
    .await;
    outcome.and(cleanup)
}
