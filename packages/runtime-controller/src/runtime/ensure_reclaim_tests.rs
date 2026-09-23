use super::*;

use std::sync::Arc;

use tokio::sync::Mutex;

/// One organization at its hosted runtime limit: a "blocker" space that already
/// owns the slot, and a "waiting" space that is about to ask for one.
struct ReclaimFixture {
    pool: crate::config::PgPool,
    state: AppState,
    waiting_project_id: Uuid,
    blocker_project_id: Uuid,
    blocker_runtime_id: Uuid,
    provider_id: String,
    provider_events: Arc<Mutex<Vec<&'static str>>>,
    _provider_handle: tokio::task::JoinHandle<()>,
}

impl ReclaimFixture {
    async fn ensure_for_waiting_space(
        &self,
    ) -> Result<RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
        ensure_runtime_launch(
            &self.state,
            self.waiting_project_id,
            None,
            self.provider_id.clone(),
            600,
            Some("Waiting space runtime".to_string()),
            None,
            RuntimeLeaseScope::Exclusive,
            OriginEnsureOptions::new(None, None, None),
        )
        .await
    }

    async fn blocker_status(&self) -> anyhow::Result<String> {
        let connection = self.pool.get().await?;
        let row = connection
            .query_one(
                "select status from runtimes where id = $1",
                &[&self.blocker_runtime_id],
            )
            .await?;
        Ok(row.get("status"))
    }

    async fn cleanup(&self) -> anyhow::Result<()> {
        let connection = self.pool.get().await?;
        connection
            .execute(
                "delete from projects where id = any($1)",
                &[&vec![self.waiting_project_id, self.blocker_project_id]],
            )
            .await?;
        Ok(())
    }
}

/// `idle_for_seconds` backdates the blocker's lease and its space's activity, so
/// a test can express "nobody has touched that space for N seconds".
async fn setup_at_hosted_runtime_limit(
    test_name: &'static str,
    reclaim_idle_seconds: i64,
    idle_for_seconds: i64,
) -> anyhow::Result<Option<ReclaimFixture>> {
    let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
        // A silent skip reads exactly like a pass. Say so, loudly.
        eprintln!(
            "[{test_name}] SKIPPED: no TEST_DATABASE_URL; run through `pnpm test:controller`"
        );
        return Ok(None);
    };

    let provider_events: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let provider_app = axum::Router::new()
        .route(
            "/runtime/ensure",
            axum::routing::post({
                let provider_events = provider_events.clone();
                move || {
                    let provider_events = provider_events.clone();
                    async move {
                        provider_events.lock().await.push("launch");
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
            .expect("serve hosted runtime reclaim test provider");
    });

    let org_id = Uuid::new_v4();
    let waiting_project_id = Uuid::new_v4();
    let blocker_project_id = Uuid::new_v4();
    let blocker_runtime_id = Uuid::new_v4();
    let blocker_lease_id = Uuid::new_v4();
    // Must satisfy is_instafy_cloud_provider_id and the org cap's provider
    // filter, or the whole limit branch is skipped.
    let provider_id = "instafy_cloud_reclaim_test";

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[
                    &org_id,
                    &format!("hosted-reclaim-{org_id}"),
                    &"Hosted runtime reclaim test",
                ],
            )
            .await?;
        // Both spaces must share one organization; an orgless project would get
        // its own and never collide with the limit.
        connection
            .execute(
                "insert into projects (id, org_id, project_type, status)
                 values ($1, $3, 'customer', 'active'),
                        ($2, $3, 'customer', 'active')",
                &[&waiting_project_id, &blocker_project_id, &org_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes
                    (id, project_id, provider, status, idle_ttl_seconds,
                     last_seen_at, endpoint_url)
                 values ($1, $2, $3, 'ready', 600, now(), 'http://runtime.test')",
                &[&blocker_runtime_id, &blocker_project_id, &provider_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, requested_at, launched_at)
                 values ($1, $2, $3, 'active',
                         now() - make_interval(secs => $4::double precision),
                         now() - make_interval(secs => $4::double precision))",
                &[
                    &blocker_lease_id,
                    &blocker_project_id,
                    &blocker_runtime_id,
                    &(idle_for_seconds as f64),
                ],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&blocker_runtime_id, &blocker_lease_id],
            )
            .await?;
        connection
            .execute(
                "insert into project_user_activity (project_id, last_active_at)
                 values ($1, now() - make_interval(secs => $2::double precision))
                 on conflict (project_id) do update set last_active_at = excluded.last_active_at",
                &[&blocker_project_id, &(idle_for_seconds as f64)],
            )
            .await?;
    }

    let provider_config = crate::config::RuntimeProviderConfig {
        id: provider_id.to_string(),
        display_name: "Hosted runtime reclaim test".to_string(),
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
        test_name,
    );
    config.runtime_providers = vec![provider_config];
    config.runtime_limit_reclaim_idle_seconds = reclaim_idle_seconds;
    let state = crate::tests::build_test_state(pool.clone(), config);

    Ok(Some(ReclaimFixture {
        pool,
        state,
        waiting_project_id,
        blocker_project_id,
        blocker_runtime_id,
        provider_id: provider_id.to_string(),
        provider_events,
        _provider_handle: provider_handle,
    }))
}

fn limit_refusal_code(error: &(StatusCode, Json<ApiError>)) -> Option<String> {
    let (status, body) = error;
    assert_eq!(*status, StatusCode::PAYMENT_REQUIRED, "{}", body.0.message);
    body.0.code.clone()
}

#[tokio::test]
async fn idle_hosted_blocker_is_reclaimed_for_a_waiting_space() -> anyhow::Result<()> {
    let Some(fixture) = setup_at_hosted_runtime_limit("hosted-reclaim-idle", 120, 3_600).await?
    else {
        return Ok(());
    };

    let launched = fixture.ensure_for_waiting_space().await;

    let result = async {
        let response = launched.map_err(|(status, body)| {
            anyhow::anyhow!("waiting space was refused ({status}): {}", body.0.message)
        })?;
        assert_eq!(response.provider, fixture.provider_id);

        assert_eq!(
            fixture.blocker_status().await?,
            "stopped",
            "the idle blocking runtime should have been stopped to free the slot"
        );
        let events = fixture.provider_events.lock().await.clone();
        assert!(
            events.contains(&"release"),
            "the provider should have been asked to release the reclaimed runtime: {events:?}"
        );
        anyhow::Ok(())
    }
    .await;

    fixture.cleanup().await?;
    result
}

#[tokio::test]
async fn busy_hosted_blocker_is_never_reclaimed() -> anyhow::Result<()> {
    let Some(fixture) = setup_at_hosted_runtime_limit("hosted-reclaim-busy", 120, 3_600).await?
    else {
        return Ok(());
    };

    {
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "insert into agent_jobs
                    (project_id, status, leased_at, lease_expires_at, leased_by_runtime_id)
                 values ($1, 'leased', now(), now() + interval '5 minutes', $2)",
                &[&fixture.blocker_project_id, &fixture.blocker_runtime_id],
            )
            .await?;
    }

    let launched = fixture.ensure_for_waiting_space().await;

    let result = async {
        let error = launched
            .err()
            .ok_or_else(|| anyhow::anyhow!("a busy blocker must still refuse the launch"))?;
        assert_eq!(
            limit_refusal_code(&error).as_deref(),
            Some("runtime_limit_reached")
        );
        assert_eq!(
            fixture.blocker_status().await?,
            "ready",
            "a runtime with leased work must not be stopped"
        );
        anyhow::Ok(())
    }
    .await;

    fixture.cleanup().await?;
    result
}

#[tokio::test]
async fn recently_used_hosted_blocker_is_never_reclaimed() -> anyhow::Result<()> {
    // Ten seconds of idleness against a two-minute window: somebody is still
    // in that space.
    let Some(fixture) = setup_at_hosted_runtime_limit("hosted-reclaim-recent", 120, 10).await?
    else {
        return Ok(());
    };

    let launched = fixture.ensure_for_waiting_space().await;

    let result = async {
        let error = launched.err().ok_or_else(|| {
            anyhow::anyhow!("a recently used blocker must still refuse the launch")
        })?;
        assert_eq!(
            limit_refusal_code(&error).as_deref(),
            Some("runtime_limit_reached")
        );
        assert_eq!(fixture.blocker_status().await?, "ready");
        anyhow::Ok(())
    }
    .await;

    fixture.cleanup().await?;
    result
}

#[tokio::test]
async fn hosted_slot_reclaim_can_be_switched_off() -> anyhow::Result<()> {
    let Some(fixture) = setup_at_hosted_runtime_limit("hosted-reclaim-off", 0, 3_600).await? else {
        return Ok(());
    };

    let launched = fixture.ensure_for_waiting_space().await;

    let result = async {
        let error = launched
            .err()
            .ok_or_else(|| anyhow::anyhow!("reclaim is disabled, so the launch must be refused"))?;
        assert_eq!(
            limit_refusal_code(&error).as_deref(),
            Some("runtime_limit_reached")
        );
        assert_eq!(fixture.blocker_status().await?, "ready");
        anyhow::Ok(())
    }
    .await;

    fixture.cleanup().await?;
    result
}
