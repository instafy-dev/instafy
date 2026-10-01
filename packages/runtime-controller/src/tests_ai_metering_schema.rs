//! The managed-AI metering tables and the org credit ledger guard, on the
//! migrated database.
//!
//! `supabase/tests/managed_ai_metering.sql` holds the single-session cases,
//! each raising `metering test failed: <case>` when it does not hold. The
//! socket-only harness (`scripts/test-durable-notifications.py`) runs it as
//! well; here it runs inside a transaction that is rolled back, so the shared
//! test database keeps none of its rows.

use crate::config::PgPool;
use crate::tests::{
    require_origin_test_pool, spawn_aborting, with_shared_db_fixture, AbortingTask, SharedDbFixture,
};
use uuid::Uuid;

const POST_METERED_DEBIT: &str =
    "insert into org_credit_ledger (org_id, project_id, delta, reason, idempotency_key, allow_overdraft)
     values ($1, $2, -3, 'managed_ai_usage', $3, true)
     on conflict do nothing";

#[tokio::test]
async fn managed_ai_metering_sql_fixture_passes() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("managed AI metering SQL fixture").await?;
    let fixture = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../supabase/tests/managed_ai_metering.sql"),
    )?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    transaction.batch_execute(&fixture).await?;
    transaction.rollback().await?;
    Ok(())
}

/// Two sessions post the same ledger key. The second waits on the balance
/// lock the first holds and, once the first commits, must skip its row
/// without debiting again. Before the guard skipped duplicates, the balance
/// moved inside the trigger and only the row was dropped by ON CONFLICT.
#[tokio::test]
async fn concurrent_same_key_inserts_debit_once() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("ledger key concurrency test").await?;
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![project_id],
    };
    with_shared_db_fixture(fixture, async move {
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into organizations (id, slug, name) values ($1, $2, 'Ledger key race')",
                    &[&org_id, &format!("ledger-key-race-{org_id}")],
                )
                .await?;
            connection
                .execute(
                    "insert into projects (id, org_id, project_type, status)
                     values ($1, $2, 'customer', 'active')",
                    &[&project_id, &org_id],
                )
                .await?;
            connection
                .execute(
                    "insert into org_credit_ledger (org_id, project_id, delta, reason)
                     values ($1, $2, 10, 'test_seed')",
                    &[&org_id, &project_id],
                )
                .await?;
        }
        let key = format!("managed-ai-usage:{}", Uuid::new_v4());

        let mut first = pool.get().await?;
        let first_post = first.transaction().await?;
        assert_eq!(
            first_post
                .execute(POST_METERED_DEBIT, &[&org_id, &project_id, &key])
                .await?,
            1
        );

        let second = pool.get_owned().await?;
        let second_pid: i32 = second
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        let second_post = spawn_aborting({
            let key = key.clone();
            async move {
                second
                    .execute(POST_METERED_DEBIT, &[&org_id, &project_id, &key])
                    .await
            }
        });
        wait_for_lock_wait(&pool, second_pid, &second_post).await?;
        first_post.commit().await?;

        assert_eq!(second_post.await??, 0, "the duplicate key wrote a row");
        let connection = pool.get().await?;
        let balance: i32 = connection
            .query_one(
                "select balance from org_credit_balances where org_id = $1",
                &[&org_id],
            )
            .await?
            .get(0);
        assert_eq!(balance, 7, "the duplicate key debited the balance again");
        let rows: i64 = connection
            .query_one(
                "select count(*) from org_credit_ledger where org_id = $1 and idempotency_key = $2",
                &[&org_id, &key],
            )
            .await?
            .get(0);
        assert_eq!(rows, 1);
        Ok(())
    })
    .await
}

/// Polls until `backend_pid` waits on a lock. Fails if `task` finishes first
/// or the backend never waits.
async fn wait_for_lock_wait<T>(
    pool: &PgPool,
    backend_pid: i32,
    task: &AbortingTask<T>,
) -> anyhow::Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let connection = pool.get().await?;
    loop {
        let waiting: bool = connection
            .query_one(
                "select exists (
                     select 1 from pg_stat_activity
                     where pid = $1 and wait_event_type = 'Lock'
                 )",
                &[&backend_pid],
            )
            .await?
            .get(0);
        if waiting {
            return Ok(());
        }
        anyhow::ensure!(
            !task.is_finished(),
            "the second post finished without waiting on the balance lock"
        );
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "the second post never waited on the balance lock"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}
