//! The chat-attachments bucket and its Storage policies, on the migrated
//! database with Supabase Storage's own schema.
//!
//! `supabase/tests/chat_attachments.sql` holds the cases, each raising
//! `chat attachment test failed: <case>` when it does not hold. The local
//! Supabase stack (`pnpm supabase:up`, database only in CI) runs Storage's
//! migrations before ours, so the policies meet the real `storage.objects`
//! table: its `owner_id` column and its triggers included. The socket-only
//! harness (`scripts/test-durable-notifications.py`) runs the same file against
//! a stub. Here it runs inside a transaction that is rolled back.

use crate::tests::require_origin_test_pool;

#[tokio::test]
async fn chat_attachments_sql_fixture_passes_on_storage() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("chat attachments SQL fixture").await?;
    let fixture = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../supabase/tests/chat_attachments.sql"),
    )?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    // Storage records its own migrations; the harness stub has no such table.
    let storage_migrated: bool = transaction
        .query_one("select to_regclass('storage.migrations') is not null", &[])
        .await?
        .get(0);
    anyhow::ensure!(
        storage_migrated,
        "the test database has no migrated Supabase Storage; start it with `pnpm supabase:up`"
    );
    transaction.batch_execute(&fixture).await?;
    transaction.rollback().await?;
    Ok(())
}
