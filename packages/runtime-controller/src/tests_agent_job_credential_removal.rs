//! A job queued or leased on a person's own AI never becomes a platform job
//! when its credential row is deleted, on the migrated database.
//!
//! `supabase/tests/agent_job_credential_removal.sql` holds the cases, each
//! raising `credential removal test failed: <case>` when it does not hold.
//! Deleting a credential row, directly or by deleting its person, fails the
//! AI jobs still queued or leased on it (`agent_jobs_fail_on_credential_removal`)
//! and leaves every other job as it was. The socket-only harness
//! (`scripts/test-durable-notifications.py`) runs the same file. Here it runs
//! inside a transaction that is rolled back.

use crate::tests::require_origin_test_pool;

#[tokio::test]
async fn agent_job_credential_removal_sql_fixture_passes() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("agent job credential removal SQL fixture").await?;
    let fixture = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../supabase/tests/agent_job_credential_removal.sql"),
    )?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    transaction.batch_execute(&fixture).await?;
    transaction.rollback().await?;
    Ok(())
}
