//! Credential rows are written only by the controller, on the migrated
//! database.
//!
//! `supabase/tests/user_credential_client_writes.sql` holds the cases, each
//! raising `user credential test failed: <case>` when it does not hold. As the
//! signed-in owner it reads a credential but cannot insert, change or delete
//! one, with the privileges as migrated and again with the writes granted
//! back. The socket-only harness (`scripts/test-durable-notifications.py`)
//! runs the same file. Here it runs inside a transaction that is rolled back.

use crate::tests::require_origin_test_pool;

#[tokio::test]
async fn user_credential_sql_fixture_refuses_client_writes() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("user credential SQL fixture").await?;
    let fixture = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../supabase/tests/user_credential_client_writes.sql"),
    )?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    transaction.batch_execute(&fixture).await?;
    transaction.rollback().await?;
    Ok(())
}
