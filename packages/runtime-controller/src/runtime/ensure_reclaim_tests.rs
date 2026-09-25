use super::*;

use std::sync::Arc;

use tokio::sync::Mutex;

/// One organization at its hosted runtime limit: a "blocker" space that already
/// owns the slot, and a "waiting" space that is about to ask for one.
struct ReclaimFixture {
    pool: crate::config::PgPool,
    state: AppState,
    org_id: Uuid,
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
        // The organization too, or every run leaves an empty one behind.
        connection
            .execute("delete from organizations where id = $1", &[&self.org_id])
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
    setup_at_hosted_runtime_limit_on(pool, test_name, reclaim_idle_seconds, idle_for_seconds)
        .await
        .map(Some)
}

/// [`setup_at_hosted_runtime_limit`] for a test that must fail, not skip,
/// without a database.
async fn require_setup_at_hosted_runtime_limit(
    test_name: &'static str,
    reclaim_idle_seconds: i64,
    idle_for_seconds: i64,
) -> anyhow::Result<ReclaimFixture> {
    let pool = crate::tests::require_origin_test_pool(test_name).await?;
    setup_at_hosted_runtime_limit_on(pool, test_name, reclaim_idle_seconds, idle_for_seconds).await
}

async fn setup_at_hosted_runtime_limit_on(
    pool: crate::config::PgPool,
    test_name: &'static str,
    reclaim_idle_seconds: i64,
    idle_for_seconds: i64,
) -> anyhow::Result<ReclaimFixture> {
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

    Ok(ReclaimFixture {
        pool,
        state,
        org_id,
        waiting_project_id,
        blocker_project_id,
        blocker_runtime_id,
        provider_id: provider_id.to_string(),
        provider_events,
        _provider_handle: provider_handle,
    })
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

/// A tunnel broker that accepts a revoke and never answers it. It records
/// when the revoke starts and when the caller abandons it (drops the call).
struct SilentRevokeBroker {
    reached: Arc<tokio::sync::Notify>,
    abandoned: Arc<std::sync::atomic::AtomicBool>,
}

#[async_trait::async_trait]
impl crate::tunnels::TunnelBroker for SilentRevokeBroker {
    fn provider_kind(&self) -> crate::tunnels::TunnelProvider {
        crate::tunnels::TunnelProvider::SelfHosted
    }

    async fn request_tunnel(
        &self,
        _ctx: crate::tunnels::TunnelRequestContext,
    ) -> anyhow::Result<crate::tunnels::TunnelAssignment> {
        anyhow::bail!("the reclaim test never requests a tunnel")
    }

    async fn revoke_tunnel(
        &self,
        _tunnel_id: &str,
        _metadata: Option<&JsonValue>,
    ) -> anyhow::Result<()> {
        struct MarkAbandoned(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for MarkAbandoned {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }

        let _abandoned = MarkAbandoned(self.abandoned.clone());
        self.reached.notify_one();
        std::future::pending::<()>().await;
        Ok(())
    }
}

/// The reclaim runs while the waiting launch holds the provider launch
/// admission, which serializes every provider launch in this process. A tunnel
/// broker that never answers the stopped blocker's revoke must therefore cost
/// that launch at most `RECLAIM_TUNNEL_REVOKE_TIMEOUT`, not wedge admission
/// for good. The broker really hangs; only the bound itself is fast-forwarded.
#[tokio::test]
async fn silent_tunnel_broker_cannot_hold_launch_admission_during_reclaim() -> anyhow::Result<()> {
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::sync::Notify;

    let Some(fixture) =
        setup_at_hosted_runtime_limit("hosted-reclaim-silent-broker", 120, 3_600).await?
    else {
        return Ok(());
    };
    let cleanup = crate::tests::SharedDbFixture {
        organizations: vec![fixture.org_id],
        projects: vec![fixture.waiting_project_id, fixture.blocker_project_id],
    };

    crate::tests::with_shared_db_fixture(cleanup, async {
        let tunnel_id = format!("reclaim-silent-broker-{}", Uuid::new_v4());
        fixture
            .pool
            .get()
            .await?
            .execute(
                "insert into runtime_tunnel_grants
                    (project_id, runtime_id, provider, tunnel_id, hostname, url, status, expires_at)
                 values ($1, $2, 'self_hosted', $3, 'reclaim.example.test',
                         'https://reclaim.example.test', 'active', now() + interval '10 minutes')",
                &[
                    &fixture.blocker_project_id,
                    &fixture.blocker_runtime_id,
                    &tunnel_id,
                ],
            )
            .await?;

        let reached = Arc::new(Notify::new());
        let abandoned = Arc::new(AtomicBool::new(false));
        let mut state = fixture.state.clone();
        state.tunnel_broker = Some(Arc::new(SilentRevokeBroker {
            reached: reached.clone(),
            abandoned: abandoned.clone(),
        }));

        let launch = crate::tests::spawn_aborting({
            let waiting_project_id = fixture.waiting_project_id;
            let provider_id = fixture.provider_id.clone();
            async move {
                ensure_runtime_launch(
                    &state,
                    waiting_project_id,
                    None,
                    provider_id,
                    600,
                    Some("Waiting space runtime".to_string()),
                    None,
                    RuntimeLeaseScope::Exclusive,
                    OriginEnsureOptions::new(None, None, None),
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(10), reached.notified())
            .await
            .expect("the reclaim never asked the tunnel broker to revoke the blocker's grant");
        assert!(
            !launch.is_finished(),
            "the launch should still be waiting on the reclaim's tunnel revoke"
        );
        assert_eq!(fixture.blocker_status().await?, "stopped");

        // Fast-forward only the bound. The clock resumes before the launch
        // returns to the database, whose pool timers must see real time.
        tokio::time::pause();
        tokio::time::advance(RECLAIM_TUNNEL_REVOKE_TIMEOUT).await;
        tokio::time::resume();

        let response = tokio::time::timeout(Duration::from_secs(10), launch)
            .await
            .expect("the launch stayed stuck behind the silent tunnel broker")?
            .map_err(|(status, body)| {
                anyhow::anyhow!("waiting space was refused ({status}): {}", body.0.message)
            })?;
        assert_eq!(response.provider, fixture.provider_id);
        assert!(
            abandoned.load(Ordering::SeqCst),
            "the reclaim should have abandoned the unanswered revoke"
        );
        let grant_status: String = fixture
            .pool
            .get()
            .await?
            .query_one(
                "select status from runtime_tunnel_grants where tunnel_id = $1",
                &[&tunnel_id],
            )
            .await?
            .get("status");
        assert_eq!(
            grant_status, "active",
            "an abandoned revoke leaves the local grant to expire"
        );
        let events = fixture.provider_events.lock().await.clone();
        assert_eq!(
            events,
            vec!["release", "launch"],
            "the waiting space launches only after the blocker was released"
        );
        Ok(())
    })
    .await
}

/// Work that lands on the blocker between the idleness check and the stop is
/// requeued. That space now waits on the limit like any other: the stop tells
/// its studio the work is its own (so it may ask again), and the limit-wait
/// sweep is told to start it once a runtime is free.
#[tokio::test]
async fn reclaim_that_requeues_work_leaves_the_reclaimed_space_waiting() -> anyhow::Result<()> {
    // Never a silent pass: this proves the reclaimed space keeps its work.
    let fixture =
        require_setup_at_hosted_runtime_limit("hosted-reclaim-requeued-work", 120, 3_600).await?;
    let cleanup = crate::tests::SharedDbFixture {
        organizations: vec![fixture.org_id],
        projects: vec![fixture.waiting_project_id, fixture.blocker_project_id],
    };

    crate::tests::with_shared_db_fixture(cleanup, async {
        let job_id = Uuid::new_v4();
        fixture
            .pool
            .get()
            .await?
            .execute(
                "insert into agent_jobs (id, project_id, status, payload, target_runtime_id)
                 values ($1, $2, 'queued', '{}'::jsonb, $3)",
                &[
                    &job_id,
                    &fixture.blocker_project_id,
                    &fixture.blocker_runtime_id,
                ],
            )
            .await?;
        let _watch = fixture
            .state
            .events
            .watch_project(fixture.blocker_project_id);
        let mut events = fixture.state.events.subscribe();

        let reclaimed = reclaim_idle_hosted_runtime_blocker(
            &fixture.state,
            &ActiveHostedRuntimeBlocker {
                runtime_id: fixture.blocker_runtime_id,
                project_id: fixture.blocker_project_id,
                project_name: None,
                display_name: None,
            },
        )
        .await;
        assert!(reclaimed, "the idle blocker should have been stopped");
        assert_eq!(fixture.blocker_status().await?, "stopped");

        let mut stopped = None;
        while let Ok(event) = events.try_recv() {
            if event.kind == "runtime.stopped"
                && event.project_id == Some(fixture.blocker_project_id)
            {
                stopped = Some(event);
            }
        }
        let stopped = stopped.ok_or_else(|| anyhow::anyhow!("no runtime.stopped published"))?;
        assert_eq!(
            stopped.data["reason"],
            json!(RUNTIME_LIMIT_RECLAIM_STOP_REASON)
        );
        assert_eq!(stopped.data["queuedJobCount"], json!(1));

        let connection = fixture.pool.get().await?;
        let job_status: String = connection
            .query_one("select status from agent_jobs where id = $1", &[&job_id])
            .await?
            .get("status");
        assert_eq!(job_status, "queued");
        let wait = connection
            .query_opt(
                "select request_source, ensure_request from hosted_runtime_limit_waits
                 where project_id = $1",
                &[&fixture.blocker_project_id],
            )
            .await?
            .ok_or_else(|| anyhow::anyhow!("the reclaimed space should be waiting"))?;
        assert_eq!(wait.get::<_, String>("request_source"), "server");
        let request = wait
            .get::<_, tokio_postgres::types::Json<JsonValue>>("ensure_request")
            .0;
        assert_eq!(request["runtimeId"], json!(fixture.blocker_runtime_id));
        assert_eq!(request["provider"], json!(fixture.provider_id));
        Ok(())
    })
    .await
}
