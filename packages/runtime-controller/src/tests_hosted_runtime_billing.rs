//! The hosted runtime credit sweep on the migrated database, across billing
//! buckets: a pass in a bucket the ledger already holds writes nothing and
//! announces nothing, and the next bucket is billed as before.

use uuid::Uuid;

use crate::config::{PgPool, RuntimeProviderConfig};
use crate::runtime;
use crate::tests::{
    build_app_config, build_test_state, queued_credit_signals, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};

const STARTING_BALANCE: i32 = 50;

/// The org's balance and its hosted-runtime ledger rows for the project.
async fn billed(pool: &PgPool, org_id: &Uuid, project_id: &Uuid) -> anyhow::Result<(i32, i64)> {
    let connection = pool.get().await?;
    let balance: i32 = connection
        .query_one(
            "select balance from org_credit_balances where org_id = $1",
            &[org_id],
        )
        .await?
        .get(0);
    let rows: i64 = connection
        .query_one(
            "select count(*) from org_credit_ledger
             where org_id = $1 and project_id = $2 and reason = 'hosted_runtime'",
            &[org_id, project_id],
        )
        .await?
        .get(0);
    Ok((balance, rows))
}

#[tokio::test]
async fn hosted_runtime_sweep_bills_each_bucket_once() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("hosted_runtime_sweep_bills_each_bucket_once").await?;
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![project_id],
    };
    with_shared_db_fixture(fixture, async {
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into organizations (id, slug, name) values ($1, $2, 'hosted billing')",
                    &[&org_id, &format!("hosted-billing-{org_id}")],
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
                    "insert into org_credit_balances (org_id, balance, credit_limit)
                     values ($1, $2, 0)
                     on conflict (org_id) do update
                       set balance = excluded.balance, credit_limit = excluded.credit_limit",
                    &[&org_id, &STARTING_BALANCE],
                )
                .await?;
            connection
                .execute(
                    "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
                     values ($1, $2, 'instafy-cloud', 'ready', 600)",
                    &[&runtime_id, &project_id],
                )
                .await?;
            connection
                .execute(
                    "insert into runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
                     values ($1, $2, $3, 'active', now() - interval '1 minute', now() - interval '1 minute')",
                    &[&lease_id, &project_id, &runtime_id],
                )
                .await?;
            connection
                .execute(
                    "update runtimes set active_lease_id = $2 where id = $1",
                    &[&runtime_id, &lease_id],
                )
                .await?;
        }

        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "hosted-runtime-billing",
        );
        config.hosted_runtime_credit_burn_amount = 1;
        config.hosted_runtime_credit_burn_interval_seconds = 600;
        let provider = RuntimeProviderConfig {
            id: "instafy-cloud".to_string(),
            display_name: "Instafy Cloud".to_string(),
            kind: "noop".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: None,
            auth_token: None,
            metadata: None,
        };
        config.runtime_providers = vec![provider.clone()];
        let state = build_test_state(pool.clone(), config);
        let (burn, interval_seconds) =
            crate::credits::resolve_hosted_runtime_credit_burn_config_for_provider(
                &state, &provider,
            );
        assert!(burn > 0, "the test provider must burn credits");
        let _watch = state.events.watch_project(project_id);
        let mut events = state.events.subscribe();

        runtime::sweep_hosted_runtime_credit_usage(&state).await?;
        assert_eq!(
            billed(&pool, &org_id, &project_id).await?,
            (STARTING_BALANCE - burn, 1)
        );
        assert_eq!(queued_credit_signals(&mut events, project_id), 1);

        // The same bucket again: nothing written, nothing announced.
        runtime::sweep_hosted_runtime_credit_usage(&state).await?;
        assert_eq!(
            billed(&pool, &org_id, &project_id).await?,
            (STARTING_BALANCE - burn, 1)
        );
        assert_eq!(queued_credit_signals(&mut events, project_id), 0);

        // One interval later the runtime is in its next bucket, which bills.
        pool.get()
            .await?
            .execute(
                "update runtime_leases
                 set launched_at = launched_at - ($2::bigint * interval '1 second')
                 where id = $1",
                &[&lease_id, &interval_seconds],
            )
            .await?;
        runtime::sweep_hosted_runtime_credit_usage(&state).await?;
        // Its credits.updated is paced per org, so it may trail the burn.
        assert_eq!(
            billed(&pool, &org_id, &project_id).await?,
            (STARTING_BALANCE - 2 * burn, 2)
        );
        Ok(())
    })
    .await
}
