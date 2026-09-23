use super::*;

#[tokio::test]
async fn explicit_runtime_id_cannot_be_rebound_to_a_different_provider() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime provider identity test").await?;
    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes
                    (id, project_id, provider, status, idle_ttl_seconds)
                 values ($1, $2, 'runtime', 'requested', 600)",
                &[&runtime_id, &project_id],
            )
            .await?;
    }

    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let (status, payload) = ensure_runtime_record(
        &transaction,
        &project_id,
        Some(runtime_id),
        "instafy-cloud",
        600,
        None,
        None,
        true,
    )
    .await
    .expect_err("an explicit self-hosted runtime id must not be rebound to hosted compute");
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(payload.0.message.contains("provider identity"));
    transaction.rollback().await?;
    drop(connection);

    let connection = pool.get().await?;
    let stored_provider: String = connection
        .query_one(
            "select provider from runtimes where id = $1",
            &[&runtime_id],
        )
        .await?
        .get(0);
    assert_eq!(stored_provider, "runtime");
    connection
        .execute("delete from projects where id = $1", &[&project_id])
        .await?;

    Ok(())
}

#[tokio::test]
async fn runtime_launch_fence_rejects_deleted_and_missing_projects() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime launch fence test").await?;

    let active_project_id = Uuid::new_v4();
    let deleted_project_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active'), ($2, 'customer', 'deleted')",
                &[&active_project_id, &deleted_project_id],
            )
            .await?;
    }

    let missing_project_id = Uuid::new_v4();
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    ensure_project_available_for_runtime_launch(&transaction, &active_project_id)
        .await
        .expect("active project should pass the runtime launch fence");

    let (deleted_status, _) =
        ensure_project_available_for_runtime_launch(&transaction, &deleted_project_id)
            .await
            .expect_err("deleted project should fail the runtime launch fence");
    assert_eq!(deleted_status, StatusCode::NOT_FOUND);

    let (missing_status, _) =
        ensure_project_available_for_runtime_launch(&transaction, &missing_project_id)
            .await
            .expect_err("missing project should fail the runtime launch fence");
    assert_eq!(missing_status, StatusCode::NOT_FOUND);
    transaction.rollback().await?;

    let connection = pool.get().await?;
    connection
        .execute(
            "delete from projects where id = $1 or id = $2",
            &[&active_project_id, &deleted_project_id],
        )
        .await?;

    Ok(())
}

#[tokio::test]
async fn runtime_launch_fence_rolls_back_when_project_is_tombstoned_after_initial_read(
) -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime launch race test").await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
    }

    let mut allocation_connection = pool.get().await?;
    let allocation_transaction = allocation_connection.transaction().await?;

    let initially_visible = load_project_record(&allocation_transaction, &project_id)
        .await
        .expect("project should be visible before the concurrent tombstone");
    assert_eq!(initially_visible._status.as_deref(), Some("active"));

    // Model the writes made by `ensure_runtime_launch` before its final
    // project check. They remain uncommitted and must disappear if the
    // concurrent tombstone wins the commit-boundary fence.
    allocation_transaction
        .execute(
            "insert into runtimes
                (id, project_id, provider, status, idle_ttl_seconds)
             values ($1, $2, 'runtime-launch-race-test', 'requested', 600)",
            &[&runtime_id, &project_id],
        )
        .await?;
    allocation_transaction
        .execute(
            "insert into runtime_leases
                (id, project_id, runtime_id, status, requested_at)
             values ($1, $2, $3, 'launching', now())",
            &[&lease_id, &project_id, &runtime_id],
        )
        .await?;

    // This update occurs after the allocation transaction's initial
    // project read. A non-key status update is compatible with the foreign
    // key locks above, so it can commit before the final FOR SHARE check.
    {
        let tombstone_connection = pool.get().await?;
        let updated = tombstone_connection
            .execute(
                "update projects set status = 'deleted', updated_at = now()
                 where id = $1",
                &[&project_id],
            )
            .await?;
        assert_eq!(updated, 1);
    }

    let (status, _) =
        ensure_project_available_for_runtime_launch(&allocation_transaction, &project_id)
            .await
            .expect_err("the commit-boundary fence should observe the tombstone");
    assert_eq!(status, StatusCode::NOT_FOUND);
    allocation_transaction.rollback().await?;

    let connection = pool.get().await?;
    let runtime_count: i64 = connection
        .query_one(
            "select count(*) from runtimes where project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    let lease_count: i64 = connection
        .query_one(
            "select count(*) from runtime_leases where project_id = $1",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(runtime_count, 0, "runtime write should have rolled back");
    assert_eq!(lease_count, 0, "lease write should have rolled back");
    connection
        .execute("delete from projects where id = $1", &[&project_id])
        .await?;

    Ok(())
}

#[tokio::test]
async fn current_launch_failure_cleanup_marks_exact_allocation_failed() -> anyhow::Result<()> {
    let pool =
        crate::tests::require_origin_test_pool("current runtime launch failure test").await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let provider = "runtime-launch-current-failure-test";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes
                    (id, project_id, provider, status, idle_ttl_seconds)
                 values ($1, $2, $3, 'requested', 600)",
                &[&runtime_id, &project_id, &provider],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, requested_at)
                 values ($1, $2, $3, 'launching', now())",
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

    let config = crate::tests::build_app_config(
        crate::tests::test_origin_private_key(),
        crate::tests::test_origin_public_key(),
        "runtime-launch-current-failure-cleanup",
    );
    let state = crate::tests::build_test_state(pool.clone(), config);
    assert!(
        mark_runtime_launch_failed_if_current(
            &state,
            &project_id,
            &runtime_id,
            &lease_id,
            provider,
        )
        .await?,
        "failure cleanup should stop the exact current launch"
    );

    let connection = pool.get().await?;
    let runtime_row = connection
        .query_one(
            "select status, active_lease_id from runtimes where id = $1",
            &[&runtime_id],
        )
        .await?;
    let lease_row = connection
        .query_one(
            "select status, released_at is not null from runtime_leases where id = $1",
            &[&lease_id],
        )
        .await?;
    assert_eq!(runtime_row.get::<_, String>("status"), "stopped");
    assert!(runtime_row
        .get::<_, Option<Uuid>>("active_lease_id")
        .is_none());
    assert_eq!(lease_row.get::<_, String>("status"), "failed");
    assert!(lease_row.get::<_, bool>(1));

    connection
        .execute("delete from projects where id = $1", &[&project_id])
        .await?;

    Ok(())
}

#[tokio::test]
async fn ambiguous_launch_quarantine_blocks_registration_and_reuse_until_release_succeeds(
) -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("runtime launch quarantine test").await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let provider = "runtime-launch-quarantine-test";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes
                    (id, project_id, provider, status, endpoint_url, task_ref,
                     last_seen_at, idle_ttl_seconds)
                 values ($1, $2, $3, 'ready', 'http://runtime.test',
                         'provider-task', now(), 600)",
                &[&runtime_id, &project_id, &provider],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, requested_at)
                 values ($1, $2, $3, 'active', now())",
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

    {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        mark_runtime_launch_cleanup_pending(
            &transaction,
            &project_id,
            &runtime_id,
            &lease_id,
            provider,
        )
        .await
        .map_err(|(status, payload)| {
            anyhow::anyhow!(
                "failed to quarantine launch ({status}): {}",
                payload.0.message
            )
        })?;
        transaction.commit().await?;
    }

    {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let lease = fetch_runtime_lease_for_update(&transaction, &lease_id)
            .await
            .map_err(|(status, payload)| {
                anyhow::anyhow!("failed to load lease ({status}): {}", payload.0.message)
            })?;
        assert_eq!(lease.status, "cleanup_pending");
        assert!(!lease_is_reusable(&lease));

        let (status, _) = ensure_runtime_lease_available_for_provider_launch(
            &transaction,
            &project_id,
            &runtime_id,
            &lease_id,
            provider,
        )
        .await
        .expect_err("a cleanup-pending lease must reject late provider registration");
        assert_eq!(status, StatusCode::CONFLICT);
        transaction.rollback().await?;
    }

    let connection = pool.get().await?;
    let runtime_row = connection
        .query_one(
            "select status, endpoint_url, task_ref, last_seen_at
             from runtimes where id = $1",
            &[&runtime_id],
        )
        .await?;
    assert_eq!(runtime_row.get::<_, String>("status"), "requested");
    assert!(runtime_row
        .get::<_, Option<String>>("endpoint_url")
        .is_none());
    assert!(runtime_row.get::<_, Option<String>>("task_ref").is_none());
    assert!(runtime_row
        .get::<_, Option<chrono::DateTime<chrono::Utc>>>("last_seen_at")
        .is_none());
    drop(connection);

    let config = crate::tests::build_app_config(
        crate::tests::test_origin_private_key(),
        crate::tests::test_origin_public_key(),
        "runtime-launch-quarantine-finalize",
    );
    let state = crate::tests::build_test_state(pool.clone(), config);
    assert!(
        mark_runtime_launch_failed_if_current(
            &state,
            &project_id,
            &runtime_id,
            &lease_id,
            provider,
        )
        .await?,
        "successful provider release should finalize the quarantined allocation"
    );

    let connection = pool.get().await?;
    let runtime_status: String = connection
        .query_one("select status from runtimes where id = $1", &[&runtime_id])
        .await?
        .get(0);
    let lease_row = connection
        .query_one(
            "select status, released_at is not null from runtime_leases where id = $1",
            &[&lease_id],
        )
        .await?;
    assert_eq!(runtime_status, "stopped");
    assert_eq!(lease_row.get::<_, String>(0), "failed");
    assert!(lease_row.get::<_, bool>(1));

    connection
        .execute("delete from projects where id = $1", &[&project_id])
        .await?;

    Ok(())
}

#[tokio::test]
async fn stopped_launch_is_rejected_and_failure_cleanup_preserves_the_release() -> anyhow::Result<()>
{
    let pool = crate::tests::require_origin_test_pool("stopped runtime launch test").await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let provider = "runtime-launch-stale-test";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes
                    (id, project_id, provider, status, idle_ttl_seconds)
                 values ($1, $2, $3, 'requested', 600)",
                &[&runtime_id, &project_id, &provider],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, requested_at)
                 values ($1, $2, $3, 'launching', now())",
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

    // The exact current runtime/lease identity is accepted while both rows are
    // locked in runtime -> lease order.
    {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        ensure_runtime_lease_available_for_provider_launch(
            &transaction,
            &project_id,
            &runtime_id,
            &lease_id,
            provider,
        )
        .await
        .expect("current launch should pass provider revalidation");
        transaction.rollback().await?;
    }

    // Model a stop that commits after allocation but before either the provider
    // launch guard or post-provider failure cleanup can lock the runtime.
    {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let runtime = fetch_runtime_for_update(&transaction, &runtime_id)
            .await
            .map_err(|(status, payload)| {
                anyhow::anyhow!(
                    "failed to lock runtime while modeling stop ({status}): {}",
                    payload.0.message
                )
            })?;
        assert_eq!(runtime.active_lease_id, Some(lease_id));
        mark_runtime_lease_released(&transaction, &runtime_id, &lease_id, false)
            .await
            .map_err(|(status, payload)| {
                anyhow::anyhow!(
                    "failed to release runtime lease while modeling stop ({status}): {}",
                    payload.0.message
                )
            })?;
        transaction
            .execute(
                "update runtimes set status = 'stopped', updated_at = now() where id = $1",
                &[&runtime_id],
            )
            .await?;
        transaction.commit().await?;
    }

    {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let (status, _) = ensure_runtime_lease_available_for_provider_launch(
            &transaction,
            &project_id,
            &runtime_id,
            &lease_id,
            provider,
        )
        .await
        .expect_err("a stopped runtime and released lease must reject provider launch");
        assert_eq!(status, StatusCode::CONFLICT);
        transaction.rollback().await?;
    }

    let config = crate::tests::build_app_config(
        crate::tests::test_origin_private_key(),
        crate::tests::test_origin_public_key(),
        "runtime-launch-stale-cleanup",
    );
    let state = crate::tests::build_test_state(pool.clone(), config);
    assert!(
        !mark_runtime_launch_failed_if_current(
            &state,
            &project_id,
            &runtime_id,
            &lease_id,
            provider,
        )
        .await?,
        "failure cleanup should no-op after stop wins the race"
    );

    let connection = pool.get().await?;
    let runtime_status: String = connection
        .query_one("select status from runtimes where id = $1", &[&runtime_id])
        .await?
        .get(0);
    let lease_row = connection
        .query_one(
            "select status, released_at is not null from runtime_leases where id = $1",
            &[&lease_id],
        )
        .await?;
    let lease_status: String = lease_row.get(0);
    let lease_released: bool = lease_row.get(1);
    assert_eq!(runtime_status, "stopped");
    assert_eq!(lease_status, "released");
    assert!(lease_released);

    connection
        .execute("delete from projects where id = $1", &[&project_id])
        .await?;

    Ok(())
}

#[tokio::test]
async fn provider_launch_guard_orders_ensure_before_tombstone_and_release() -> anyhow::Result<()> {
    use std::sync::Arc;

    use tokio::sync::{Mutex, Semaphore};

    let pool = crate::tests::require_origin_test_pool("provider launch guard test").await?;

    let provider_events: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let ensure_started = Arc::new(Semaphore::new(0));
    let finish_ensure = Arc::new(Semaphore::new(0));
    let provider_app = axum::Router::new()
        .route(
            "/runtime/ensure",
            axum::routing::post({
                let provider_events = provider_events.clone();
                let ensure_started = ensure_started.clone();
                let finish_ensure = finish_ensure.clone();
                move || {
                    let provider_events = provider_events.clone();
                    let ensure_started = ensure_started.clone();
                    let finish_ensure = finish_ensure.clone();
                    async move {
                        provider_events.lock().await.push("ensure_started");
                        ensure_started.add_permits(1);
                        finish_ensure
                            .acquire_owned()
                            .await
                            .expect("finish ensure semaphore closed")
                            .forget();
                        provider_events.lock().await.push("ensure_finished");
                        Json(json!({ "message": "runtime ensured" }))
                    }
                }
            }),
        )
        .route(
            "/runtime/release",
            axum::routing::post({
                let provider_events = provider_events.clone();
                move || {
                    let provider_events = provider_events.clone();
                    async move {
                        provider_events.lock().await.push("release");
                        StatusCode::NO_CONTENT
                    }
                }
            }),
        );
    let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let provider_address = provider_listener.local_addr()?;
    let provider_handle = tokio::spawn(async move {
        axum::serve(provider_listener, provider_app)
            .await
            .expect("serve runtime launch guard test provider");
    });

    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let reusable_project_id = Uuid::new_v4();
    let reusable_runtime_id = Uuid::new_v4();
    let reusable_lease_id = Uuid::new_v4();
    let provider_id = "runtime_launch_guard_test";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("runtime-launch-guard-{org_id}"),
                    &"Runtime launch guard test",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, project_type, status)
                 values ($1, $3, 'customer', 'active'),
                        ($2, $3, 'customer', 'active')",
                &[&project_id, &reusable_project_id, &org_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes
                    (id, project_id, provider, status, idle_ttl_seconds,
                     last_seen_at, endpoint_url)
                 values ($1, $2, $3, 'ready', 600, now(), 'http://runtime.test')",
                &[&reusable_runtime_id, &reusable_project_id, &provider_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, requested_at, launched_at)
                 values ($1, $2, $3, 'active', now(), now())",
                &[
                    &reusable_lease_id,
                    &reusable_project_id,
                    &reusable_runtime_id,
                ],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&reusable_runtime_id, &reusable_lease_id],
            )
            .await?;
    }

    let provider_config = crate::config::RuntimeProviderConfig {
        id: provider_id.to_string(),
        display_name: "Runtime launch guard test".to_string(),
        kind: "test".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{provider_address}")),
        auth_token: None,
        metadata: None,
    };
    let mut config = crate::tests::build_app_config(
        crate::tests::test_origin_private_key(),
        crate::tests::test_origin_public_key(),
        "runtime-launch-provider-guard",
    );
    config.runtime_providers = vec![provider_config.clone()];
    let state = crate::tests::build_test_state(pool.clone(), config);

    let ensure_state = state.clone();
    let mut ensure_handle = tokio::spawn(async move {
        ensure_runtime_launch(
            &ensure_state,
            project_id,
            None,
            provider_id.to_string(),
            600,
            Some("Launch guard test".to_string()),
            None,
            RuntimeLeaseScope::Exclusive,
            OriginEnsureOptions::new(None, None, None),
        )
        .await
    });

    tokio::select! {
        permit = tokio::time::timeout(Duration::from_secs(5), ensure_started.acquire_owned()) => {
            permit??.forget();
        }
        result = &mut ensure_handle => {
            let result = result?;
            let detail = match result {
                Ok(_) => "runtime ensure returned before contacting provider".to_string(),
                Err((status, body)) => format!("runtime ensure failed ({status}): {}", body.0.message),
            };
            anyhow::bail!(detail);
        }
    }

    // A launch in another project owns the process-global provider admission
    // permit, but a database-only reuse must never wait behind it.
    let reused = tokio::time::timeout(
        Duration::from_secs(2),
        ensure_runtime_launch(
            &state,
            reusable_project_id,
            Some(reusable_runtime_id),
            provider_id.to_string(),
            600,
            Some("Reusable runtime".to_string()),
            None,
            RuntimeLeaseScope::Exclusive,
            OriginEnsureOptions::new(None, None, None),
        ),
    )
    .await
    .expect("runtime reuse should bypass provider launch admission")
    .map_err(|(status, body)| {
        anyhow::anyhow!("runtime reuse failed ({status}): {}", body.0.message)
    })?;
    assert_eq!(reused.runtime_id, reusable_runtime_id.to_string());
    assert_eq!(reused.lease_id, reusable_lease_id.to_string());
    assert_eq!(
        provider_events.lock().await.as_slice(),
        &["ensure_started"],
        "reusing an existing runtime must not contact the provider"
    );

    // The launch guard locks runtime first, then lease, before it locks the
    // project. A stop therefore cannot overtake an in-flight provider ensure.
    let identity_connection = pool.get().await?;
    let identity = identity_connection
        .query_one(
            "select id, active_lease_id from runtimes where project_id = $1",
            &[&project_id],
        )
        .await?;
    let runtime_id: Uuid = identity.get("id");
    let active_lease_id: Option<Uuid> = identity.get("active_lease_id");
    assert!(active_lease_id.is_some());

    let mut stop_probe_connection = pool.get().await?;
    let stop_probe = stop_probe_connection.transaction().await?;
    stop_probe
        .batch_execute("set local lock_timeout = '250ms'")
        .await?;
    let stop_lock_error = stop_probe
        .query_one(
            "select id from runtimes where id = $1 for update",
            &[&runtime_id],
        )
        .await
        .expect_err("runtime stop should wait for the in-flight provider ensure");
    assert_eq!(
        stop_lock_error.code().map(|code| code.code().to_string()),
        Some("55P03".to_string()),
        "expected PostgreSQL lock_not_available from the runtime launch lock"
    );
    stop_probe.rollback().await?;
    drop(stop_probe_connection);
    drop(identity_connection);

    // The provider is deliberately paused mid-ensure. A tombstone must be
    // unable to acquire its project-row update lock until that call exits.
    // A database lock timeout gives us a deterministic assertion without
    // relying on sleeps or increasingly long polling windows.
    let mut tombstone_probe_connection = pool.get().await?;
    let tombstone_probe = tombstone_probe_connection.transaction().await?;
    tombstone_probe
        .batch_execute("set local lock_timeout = '250ms'")
        .await?;
    let lock_error = tombstone_probe
        .execute(
            "update projects set status = 'deleted', updated_at = now() where id = $1",
            &[&project_id],
        )
        .await
        .expect_err("tombstone should wait for the in-flight provider ensure");
    assert_eq!(
        lock_error.code().map(|code| code.code().to_string()),
        Some("55P03".to_string()),
        "expected PostgreSQL lock_not_available from the launch guard"
    );
    tombstone_probe.rollback().await?;
    assert_eq!(
        provider_events.lock().await.as_slice(),
        &["ensure_started"],
        "provider release must not overtake an in-flight ensure"
    );

    finish_ensure.add_permits(1);
    let ensure_result = tokio::time::timeout(Duration::from_secs(5), ensure_handle).await??;
    let ensured = ensure_result.map_err(|(status, body)| {
        anyhow::anyhow!("runtime ensure failed ({status}): {}", body.0.message)
    })?;

    let connection = pool.get().await?;
    let updated = connection
        .execute(
            "update projects set status = 'deleted', updated_at = now() where id = $1",
            &[&project_id],
        )
        .await?;
    assert_eq!(updated, 1, "tombstone should succeed after ensure exits");

    call_provider_endpoint(
        &state,
        &provider_config,
        "/runtime/release",
        &json!({
            "project_id": project_id,
            "runtime_id": ensured.runtime_id,
        }),
        Duration::from_secs(5),
    )
    .await?;
    assert_eq!(
        provider_events.lock().await.as_slice(),
        &["ensure_started", "ensure_finished", "release"],
        "strict cleanup release must be ordered after provider ensure"
    );

    connection
        .execute("delete from organizations where id = $1", &[&org_id])
        .await?;
    provider_handle.abort();

    Ok(())
}

#[tokio::test]
async fn queued_launch_uses_provider_snapshot_refreshed_after_admission_wait() -> anyhow::Result<()>
{
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use axum::http::header::AUTHORIZATION;
    use tokio::sync::{Mutex, Notify};

    let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
        eprintln!("skipping provider refresh admission test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    // A provider unrelated to the target request owns the process-global
    // admission permit. This makes the target launch's registry refresh race
    // deterministic without allowing the target's old endpoint to receive a
    // setup request.
    let blocker_started = Arc::new(Notify::new());
    let finish_blocker = Arc::new(Notify::new());
    let blocker_app = axum::Router::new().route(
        "/runtime/ensure",
        axum::routing::post({
            let blocker_started = blocker_started.clone();
            let finish_blocker = finish_blocker.clone();
            move || {
                let blocker_started = blocker_started.clone();
                let finish_blocker = finish_blocker.clone();
                async move {
                    blocker_started.notify_one();
                    finish_blocker.notified().await;
                    Json(json!({ "message": "blocker ensured" }))
                }
            }
        }),
    );
    let blocker_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let blocker_address = blocker_listener.local_addr()?;
    let blocker_server = tokio::spawn(async move {
        axum::serve(blocker_listener, blocker_app)
            .await
            .expect("serve provider refresh blocker");
    });

    let old_endpoint_requests = Arc::new(AtomicUsize::new(0));
    let old_app = axum::Router::new().route(
        "/runtime/ensure",
        axum::routing::post({
            let old_endpoint_requests = old_endpoint_requests.clone();
            move || {
                let old_endpoint_requests = old_endpoint_requests.clone();
                async move {
                    old_endpoint_requests.fetch_add(1, Ordering::SeqCst);
                    Json(json!({ "message": "stale provider unexpectedly called" }))
                }
            }
        }),
    );
    let old_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let old_address = old_listener.local_addr()?;
    let old_server = tokio::spawn(async move {
        axum::serve(old_listener, old_app)
            .await
            .expect("serve stale provider endpoint");
    });

    let new_endpoint_auth = Arc::new(Mutex::new(Vec::<String>::new()));
    let new_app = axum::Router::new().route(
        "/runtime/ensure",
        axum::routing::post({
            let new_endpoint_auth = new_endpoint_auth.clone();
            move |headers: axum::http::HeaderMap| {
                let new_endpoint_auth = new_endpoint_auth.clone();
                async move {
                    let authorization = headers
                        .get(AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    new_endpoint_auth.lock().await.push(authorization);
                    Json(json!({ "message": "refreshed provider ensured" }))
                }
            }
        }),
    );
    let new_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let new_address = new_listener.local_addr()?;
    let new_server = tokio::spawn(async move {
        axum::serve(new_listener, new_app)
            .await
            .expect("serve refreshed provider endpoint");
    });

    let org_id = Uuid::new_v4();
    let blocker_project_id = Uuid::new_v4();
    let target_project_id = Uuid::new_v4();
    let blocker_provider_id = "runtime_launch_refresh_blocker";
    let target_provider_id = "runtime_launch_refresh_target";
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("runtime-launch-refresh-{org_id}"),
                    &"Runtime launch provider refresh test",
                ],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, project_type, status)
                 values ($1, $3, 'customer', 'active'),
                        ($2, $3, 'customer', 'active')",
                &[&blocker_project_id, &target_project_id, &org_id],
            )
            .await?;
    }

    let blocker_config = crate::config::RuntimeProviderConfig {
        id: blocker_provider_id.to_string(),
        display_name: "Provider refresh blocker".to_string(),
        kind: "test".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{blocker_address}")),
        auth_token: Some("blocker-token".to_string()),
        metadata: None,
    };
    let old_target_config = crate::config::RuntimeProviderConfig {
        id: target_provider_id.to_string(),
        display_name: "Stale target provider".to_string(),
        kind: "test-old".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{old_address}")),
        auth_token: Some("old-target-token".to_string()),
        metadata: Some(json!({ "generation": "old" })),
    };
    let new_target_config = crate::config::RuntimeProviderConfig {
        id: target_provider_id.to_string(),
        display_name: "Refreshed target provider".to_string(),
        kind: "test-new".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: Some(format!("http://{new_address}")),
        auth_token: Some("new-target-token".to_string()),
        metadata: Some(json!({ "generation": "new" })),
    };
    let mut config = crate::tests::build_app_config(
        crate::tests::test_origin_private_key(),
        crate::tests::test_origin_public_key(),
        "runtime-launch-provider-refresh",
    );
    config.runtime_providers = vec![blocker_config.clone(), old_target_config];
    let state = crate::tests::build_test_state(pool.clone(), config);

    let blocker_state = state.clone();
    let mut blocker_handle = tokio::spawn(async move {
        ensure_runtime_launch(
            &blocker_state,
            blocker_project_id,
            None,
            blocker_provider_id.to_string(),
            600,
            Some("Provider refresh blocker".to_string()),
            None,
            RuntimeLeaseScope::Exclusive,
            OriginEnsureOptions::new(None, None, None),
        )
        .await
    });
    tokio::select! {
        started = tokio::time::timeout(Duration::from_secs(5), blocker_started.notified()) => {
            started?;
        }
        result = &mut blocker_handle => {
            let result = result?;
            let detail = match result {
                Ok(_) => "admission blocker returned before its provider was paused".to_string(),
                Err((status, body)) => format!("admission blocker failed ({status}): {}", body.0.message),
            };
            anyhow::bail!(detail);
        }
    }

    let admission_hook = ProviderLaunchAdmissionTestHook {
        reached: Arc::new(Notify::new()),
        proceed: Arc::new(Notify::new()),
        waiting: Arc::new(Notify::new()),
    };
    let target_state = state.clone();
    let target_hook = admission_hook.clone();
    let target_handle = tokio::spawn(async move {
        ensure_runtime_launch_inner(
            &target_state,
            target_project_id,
            None,
            target_provider_id.to_string(),
            600,
            Some("Provider refresh target".to_string()),
            None,
            RuntimeLeaseScope::Exclusive,
            OriginEnsureOptions::new(None, None, None),
            Some(target_hook),
        )
        .await
    });

    tokio::time::timeout(Duration::from_secs(5), admission_hook.reached.notified()).await?;

    // The target has completed its database-only probe using the old config.
    // Replace the entire registry generation before it enters the already-held
    // admission queue. The second allocation pass must resolve this generation
    // once and use it for authorization, kind, endpoint, token, and metadata.
    let mut refreshed_configs = HashMap::new();
    refreshed_configs.insert(
        crate::provider_identifiers::provider_id_key(&blocker_config.id),
        blocker_config,
    );
    refreshed_configs.insert(
        crate::provider_identifiers::provider_id_key(&new_target_config.id),
        new_target_config,
    );
    state
        .provider_registry
        .replace(refreshed_configs, blocker_provider_id.to_string());

    admission_hook.proceed.notify_one();
    tokio::time::timeout(Duration::from_secs(5), admission_hook.waiting.notified()).await?;
    assert_eq!(
        old_endpoint_requests.load(Ordering::SeqCst),
        0,
        "the stale target endpoint must not receive a request while admission is blocked"
    );

    finish_blocker.notify_one();
    let blocker_result = tokio::time::timeout(Duration::from_secs(5), blocker_handle).await??;
    blocker_result.map_err(|(status, body)| {
        anyhow::anyhow!("admission blocker failed ({status}): {}", body.0.message)
    })?;
    let target_result = tokio::time::timeout(Duration::from_secs(5), target_handle).await??;
    target_result.map_err(|(status, body)| {
        anyhow::anyhow!("target launch failed ({status}): {}", body.0.message)
    })?;

    assert_eq!(
        old_endpoint_requests.load(Ordering::SeqCst),
        0,
        "the queued launch must never call the stale provider endpoint"
    );
    assert_eq!(
        new_endpoint_auth.lock().await.as_slice(),
        &["Bearer new-target-token".to_string()],
        "the queued launch must route to the refreshed endpoint with its matching token"
    );

    let connection = pool.get().await?;
    connection
        .execute("delete from organizations where id = $1", &[&org_id])
        .await?;
    blocker_server.abort();
    old_server.abort();
    new_server.abort();

    Ok(())
}

/// Guard on existing behaviour rather than a regression test for a fix: the
/// launch path already returned its database-only probe connection before
/// waiting for provider admission. A launch deliberately keeps one runtime ->
/// lease -> project guard across the provider ensure (see
/// `provider_launch_guard_orders_ensure_before_tombstone_and_release`), and
/// that fence must stay the only pool slot pinned by provider I/O: a second
/// launch queues for admission outside the pool, so with two connections the
/// rest of the controller still gets one while the provider is slow. Holding
/// the probe connection across the admission wait makes the pool probe below
/// time out.
#[tokio::test]
async fn slow_provider_ensure_pins_at_most_one_pool_connection() -> anyhow::Result<()> {
    use std::sync::Arc;

    use tokio::sync::{Notify, Semaphore};

    let pool = crate::tests::require_origin_test_pool_with_max_size(
        "provider ensure connection hygiene test",
        2,
    )
    .await?;
    let org_id = Uuid::new_v4();
    let slow_project_id = Uuid::new_v4();
    let queued_project_id = Uuid::new_v4();
    let fixture = crate::tests::SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![slow_project_id, queued_project_id],
    };

    crate::tests::with_shared_db_fixture(fixture, async {
        let ensure_started = Arc::new(Semaphore::new(0));
        let finish_ensure = Arc::new(Semaphore::new(0));
        let provider_app = axum::Router::new().route(
            "/runtime/ensure",
            axum::routing::post({
                let ensure_started = ensure_started.clone();
                let finish_ensure = finish_ensure.clone();
                move || {
                    let ensure_started = ensure_started.clone();
                    let finish_ensure = finish_ensure.clone();
                    async move {
                        ensure_started.add_permits(1);
                        finish_ensure
                            .acquire_owned()
                            .await
                            .expect("finish ensure semaphore closed")
                            .forget();
                        Json(json!({ "message": "runtime ensured" }))
                    }
                }
            }),
        );
        let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let provider_address = provider_listener.local_addr()?;
        let _provider_server = crate::tests::spawn_aborting(async move {
            axum::serve(provider_listener, provider_app)
                .await
                .expect("serve slow ensure provider");
        });

        let provider_id = "runtime_connection_hygiene_test";
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into organizations (id, slug, name) values ($1, $2, $3)",
                    &[
                        &org_id,
                        &format!("runtime-connection-hygiene-{org_id}"),
                        &"Runtime connection hygiene test",
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into projects (id, org_id, project_type, status)
                     values ($1, $3, 'customer', 'active'),
                            ($2, $3, 'customer', 'active')",
                    &[&slow_project_id, &queued_project_id, &org_id],
                )
                .await?;
        }

        let mut config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "runtime-connection-hygiene",
        );
        config.runtime_providers = vec![crate::config::RuntimeProviderConfig {
            id: provider_id.to_string(),
            display_name: "Slow ensure provider".to_string(),
            kind: "test".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: Some(format!("http://{provider_address}")),
            auth_token: None,
            metadata: None,
        }];
        let state = crate::tests::build_test_state(pool.clone(), config);

        let slow_state = state.clone();
        let mut slow_launch = crate::tests::spawn_aborting(async move {
            ensure_runtime_launch(
                &slow_state,
                slow_project_id,
                None,
                provider_id.to_string(),
                600,
                Some("Slow provider launch".to_string()),
                None,
                RuntimeLeaseScope::Exclusive,
                OriginEnsureOptions::new(None, None, None),
            )
            .await
        });
        tokio::select! {
            permit = tokio::time::timeout(Duration::from_secs(5), ensure_started.acquire_owned()) => {
                permit??.forget();
            }
            result = &mut slow_launch => {
                let detail = match result? {
                    Ok(_) => "slow launch returned before contacting the provider".to_string(),
                    Err((status, body)) => {
                        format!("slow launch failed ({status}): {}", body.0.message)
                    }
                };
                anyhow::bail!(detail);
            }
        }

        // A second launch finishes its database-only probe, returns that
        // connection, and then waits for provider admission behind the slow one.
        let admission_hook = ProviderLaunchAdmissionTestHook {
            reached: Arc::new(Notify::new()),
            proceed: Arc::new(Notify::new()),
            waiting: Arc::new(Notify::new()),
        };
        let queued_state = state.clone();
        let queued_hook = admission_hook.clone();
        let queued_launch = crate::tests::spawn_aborting(async move {
            ensure_runtime_launch_inner(
                &queued_state,
                queued_project_id,
                None,
                provider_id.to_string(),
                600,
                Some("Queued provider launch".to_string()),
                None,
                RuntimeLeaseScope::Exclusive,
                OriginEnsureOptions::new(None, None, None),
                Some(queued_hook),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), admission_hook.reached.notified()).await?;
        admission_hook.proceed.notify_one();
        tokio::time::timeout(Duration::from_secs(5), admission_hook.waiting.notified()).await?;

        // One slot is the slow launch's guard. The other must still be
        // available to an unrelated request while the provider is paused.
        let probe = tokio::time::timeout(Duration::from_secs(2), pool.get())
            .await
            .expect("a slow provider ensure left no pool connection for other requests")?;
        probe.query_one("select 1", &[]).await?;
        drop(probe);

        finish_ensure.add_permits(2);
        for (label, handle) in [("slow", slow_launch), ("queued", queued_launch)] {
            tokio::time::timeout(Duration::from_secs(10), handle)
                .await??
                .map_err(|(status, body)| {
                    anyhow::anyhow!("{label} launch failed ({status}): {}", body.0.message)
                })?;
        }
        Ok(())
    })
    .await
}
