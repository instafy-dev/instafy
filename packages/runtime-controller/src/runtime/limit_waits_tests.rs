//! Database-backed tests for the hosted runtime limit-wait retry.
//!
//! Each test builds one organization at its hosted runtime limit: a "blocker"
//! space owns the only slot and one or more "waiting" spaces have work queued
//! behind it. Time is moved by editing timestamps (the blocker's idleness, a
//! wait's `next_attempt_at`, a job's `created_at`), never by sleeping.

use super::*;

use std::sync::Arc;

use tokio::sync::Mutex;

use crate::runtime::ensure::{ensure_runtime_launch_recording_limit_wait, OriginEnsureOptions};
use crate::state::ControllerEvent;

const PROVIDER_ID: &str = "instafy_cloud_limit_wait_test";
const HOSTED_DISPLAY_NAME: &str = "Hosted Runtime";

struct LimitWaitFixture {
    pool: crate::config::PgPool,
    state: AppState,
    org_id: Uuid,
    blocker_project_id: Uuid,
    blocker_runtime_id: Uuid,
    blocker_lease_id: Uuid,
    waiting_project_ids: Vec<Uuid>,
    provider_events: Arc<Mutex<Vec<&'static str>>>,
    _provider_handle: tokio::task::JoinHandle<()>,
}

impl LimitWaitFixture {
    fn shared_db_fixture(&self) -> crate::tests::SharedDbFixture {
        let mut projects = self.waiting_project_ids.clone();
        projects.push(self.blocker_project_id);
        crate::tests::SharedDbFixture {
            organizations: vec![self.org_id],
            projects,
        }
    }

    fn waiting(&self) -> Uuid {
        self.waiting_project_ids[0]
    }

    /// The studio's own ensure for a waiting space, as `useHostedRuntimeEnsure`
    /// sends it.
    async fn user_ensure(
        &self,
        project_id: Uuid,
    ) -> Result<crate::runtime::ensure::RuntimeEnsureResponse, (StatusCode, Json<ApiError>)> {
        ensure_runtime_launch_recording_limit_wait(
            &self.state,
            LimitWaitSource::User,
            project_id,
            None,
            PROVIDER_ID.to_string(),
            600,
            Some(HOSTED_DISPLAY_NAME.to_string()),
            Some(json!({ "source": "studio", "sizeId": "boost" })),
            RuntimeLeaseScope::Exclusive,
            OriginEnsureOptions::new(
                Some("hosted".to_string()),
                Some(vec!["http".to_string()]),
                None,
            ),
        )
        .await
    }

    /// Refuse a waiting space once through the real ensure path, so its wait
    /// row is exactly what production records.
    async fn refuse(&self, project_id: Uuid) -> anyhow::Result<()> {
        let error =
            self.user_ensure(project_id).await.err().ok_or_else(|| {
                anyhow::anyhow!("the organization limit should refuse this space")
            })?;
        assert!(
            is_runtime_limit_refusal(&error),
            "expected runtime_limit_reached, got {} {:?}",
            error.0,
            error.1 .0.code
        );
        Ok(())
    }

    async fn queue_job(&self, project_id: Uuid) -> anyhow::Result<Uuid> {
        let job_id = Uuid::new_v4();
        self.pool
            .get()
            .await?
            .execute(
                "insert into agent_jobs (id, project_id, status, payload)
                 values ($1, $2, 'queued', '{}'::jsonb)",
                &[&job_id, &project_id],
            )
            .await?;
        Ok(job_id)
    }

    /// A queued job with the run and conversation dispatch creates for it.
    async fn queue_conversation_job(&self, project_id: Uuid) -> anyhow::Result<(Uuid, Uuid, Uuid)> {
        let conversation_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        let connection = self.pool.get().await?;
        connection
            .execute(
                "insert into conversations (id, project_id, metadata, visibility)
                 values ($1, $2, '{}'::jsonb, 'public')",
                &[&conversation_id, &project_id],
            )
            .await?;
        connection
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status)
                 values ($1, $2, $3, 'prompt', 'queued')",
                &[&run_id, &project_id, &conversation_id],
            )
            .await?;
        connection
            .execute(
                "insert into agent_jobs (id, project_id, run_id, conversation_id, status, payload)
                 values ($1, $2, $3, $4, 'queued', '{}'::jsonb)",
                &[&job_id, &project_id, &run_id, &conversation_id],
            )
            .await?;
        Ok((job_id, run_id, conversation_id))
    }

    /// Nobody has touched the blocker's space for `seconds`.
    async fn set_blocker_idle_for(&self, seconds: i64) -> anyhow::Result<()> {
        let connection = self.pool.get().await?;
        connection
            .execute(
                "update runtime_leases
                 set requested_at = now() - make_interval(secs => $2::double precision),
                     launched_at = now() - make_interval(secs => $2::double precision)
                 where id = $1",
                &[&self.blocker_lease_id, &(seconds as f64)],
            )
            .await?;
        connection
            .execute(
                "insert into project_user_activity (project_id, last_active_at)
                 values ($1, now() - make_interval(secs => $2::double precision))
                 on conflict (project_id) do update set last_active_at = excluded.last_active_at",
                &[&self.blocker_project_id, &(seconds as f64)],
            )
            .await?;
        Ok(())
    }

    /// Let the backoff elapse without sleeping.
    async fn make_due(&self, project_id: Uuid) -> anyhow::Result<()> {
        self.pool
            .get()
            .await?
            .execute(
                "update hosted_runtime_limit_waits
                 set next_attempt_at = now() - interval '1 second'
                 where project_id = $1",
                &[&project_id],
            )
            .await?;
        Ok(())
    }

    async fn wait_row(&self, project_id: Uuid) -> anyhow::Result<Option<WaitRow>> {
        let row = self
            .pool
            .get()
            .await?
            .query_opt(
                "select attempts,
                        extract(epoch from next_attempt_at - now())::double precision
                          as next_attempt_in,
                        claimed_until is not null and claimed_until > now() as claimed,
                        request_source,
                        ensure_request,
                        last_error_code
                 from hosted_runtime_limit_waits
                 where project_id = $1",
                &[&project_id],
            )
            .await?;
        Ok(row.map(|row| WaitRow {
            attempts: row.get("attempts"),
            next_attempt_in: row.get("next_attempt_in"),
            claimed: row.get("claimed"),
            request_source: row.get("request_source"),
            ensure_request: row.get::<_, PgJson<JsonValue>>("ensure_request").0,
            last_error_code: row.get("last_error_code"),
        }))
    }

    async fn blocker_status(&self) -> anyhow::Result<String> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one(
                "select status from runtimes where id = $1",
                &[&self.blocker_runtime_id],
            )
            .await?
            .get("status"))
    }

    /// Whether the space holds a hosted generation with an unreleased lease.
    async fn has_launched_runtime(&self, project_id: Uuid) -> anyhow::Result<bool> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one(
                "select exists (
                   select 1 from runtimes r
                   join runtime_leases rl on rl.id = r.active_lease_id
                   where r.project_id = $1 and rl.released_at is null
                 ) as launched",
                &[&project_id],
            )
            .await?
            .get("launched"))
    }

    async fn job_state(
        &self,
        job_id: Uuid,
    ) -> anyhow::Result<(String, Option<String>, Option<String>)> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select status, outcome, error_message from agent_jobs where id = $1",
                &[&job_id],
            )
            .await?;
        Ok((
            row.get("status"),
            row.get("outcome"),
            row.get("error_message"),
        ))
    }

    async fn provider_events(&self) -> Vec<&'static str> {
        self.provider_events.lock().await.clone()
    }
}

#[derive(Debug)]
struct WaitRow {
    attempts: i32,
    next_attempt_in: f64,
    claimed: bool,
    request_source: String,
    ensure_request: JsonValue,
    last_error_code: Option<String>,
}

fn drain_events(
    receiver: &mut tokio::sync::broadcast::Receiver<ControllerEvent>,
) -> Vec<ControllerEvent> {
    let mut events = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        events.push(event);
    }
    events
}

/// `blocker_idle_for_seconds` backdates the blocker's lease and its space's
/// activity. The reclaim window is the production default, 120 seconds.
async fn setup(
    test_name: &'static str,
    waiting_spaces: usize,
    blocker_idle_for_seconds: i64,
) -> anyhow::Result<LimitWaitFixture> {
    // Never a silent pass: these tests exist to prove the retry works.
    let pool = crate::tests::require_origin_test_pool(test_name).await?;

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
            .expect("serve limit wait test provider");
    });

    let org_id = Uuid::new_v4();
    let blocker_project_id = Uuid::new_v4();
    let blocker_runtime_id = Uuid::new_v4();
    let blocker_lease_id = Uuid::new_v4();
    let waiting_project_ids: Vec<Uuid> = (0..waiting_spaces).map(|_| Uuid::new_v4()).collect();

    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[&org_id, &format!("limit-wait-{org_id}"), &"Limit wait test"],
            )
            .await?;
        let mut all_projects = waiting_project_ids.clone();
        all_projects.push(blocker_project_id);
        connection
            .execute(
                "insert into projects (id, org_id, project_type, status)
                 select id, $2, 'customer', 'active' from unnest($1::uuid[]) as id",
                &[&all_projects, &org_id],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes
                    (id, project_id, provider, status, idle_ttl_seconds,
                     last_seen_at, endpoint_url, display_name)
                 values ($1, $2, $3, 'ready', 600, now(), 'http://runtime.test', $4)",
                &[
                    &blocker_runtime_id,
                    &blocker_project_id,
                    &PROVIDER_ID,
                    &HOSTED_DISPLAY_NAME,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases (id, project_id, runtime_id, status)
                 values ($1, $2, $3, 'active')",
                &[&blocker_lease_id, &blocker_project_id, &blocker_runtime_id],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&blocker_runtime_id, &blocker_lease_id],
            )
            .await?;
        // Dispatch leaves each refused space a `requested` row with no lease.
        // It must not read as a live runtime.
        for project_id in &waiting_project_ids {
            connection
                .execute(
                    "insert into runtimes
                        (id, project_id, provider, status, idle_ttl_seconds, display_name)
                     values ($1, $2, $3, 'requested', 600, $4)",
                    &[
                        &Uuid::new_v4(),
                        project_id,
                        &PROVIDER_ID,
                        &HOSTED_DISPLAY_NAME,
                    ],
                )
                .await?;
        }
    }

    let provider_config = crate::config::RuntimeProviderConfig {
        id: PROVIDER_ID.to_string(),
        display_name: "Limit wait test".to_string(),
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
    config.runtime_limit_reclaim_idle_seconds = 120;
    let state = crate::tests::build_test_state(pool.clone(), config);

    let fixture = LimitWaitFixture {
        pool,
        state,
        org_id,
        blocker_project_id,
        blocker_runtime_id,
        blocker_lease_id,
        waiting_project_ids,
        provider_events,
        _provider_handle: provider_handle,
    };
    fixture
        .set_blocker_idle_for(blocker_idle_for_seconds)
        .await?;
    Ok(fixture)
}

fn policy() -> LimitWaitPolicy {
    LimitWaitPolicy::default()
}

#[tokio::test]
async fn a_limit_refusal_records_the_refused_request_and_a_user_request_outranks_a_server_one(
) -> anyhow::Result<()> {
    let fixture = setup("limit-wait-record", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;

        let wait = fixture
            .wait_row(waiting)
            .await?
            .ok_or_else(|| anyhow::anyhow!("the refusal should have recorded a wait"))?;
        assert_eq!(wait.attempts, 0);
        assert_eq!(wait.request_source, "user");
        assert_eq!(
            wait.last_error_code.as_deref(),
            Some("runtime_limit_reached")
        );
        assert!(
            (25.0..=31.0).contains(&wait.next_attempt_in),
            "first retry comes one backoff step after the refusal: {wait:?}"
        );
        assert_eq!(wait.ensure_request["provider"], json!(PROVIDER_ID));
        assert_eq!(
            wait.ensure_request["displayName"],
            json!(HOSTED_DISPLAY_NAME)
        );
        assert_eq!(wait.ensure_request["metadata"]["sizeId"], json!("boost"));
        assert_eq!(wait.ensure_request["originMode"], json!("hosted"));

        // A server-initiated ensure for the same space (the dispatch
        // reconnect) is refused too; it must not replace the user's choices.
        let server_refusal = ensure_runtime_launch_recording_limit_wait(
            &fixture.state,
            LimitWaitSource::Server,
            waiting,
            None,
            PROVIDER_ID.to_string(),
            600,
            Some(HOSTED_DISPLAY_NAME.to_string()),
            Some(json!({ "source": "dispatch_runtime_alert" })),
            RuntimeLeaseScope::Exclusive,
            OriginEnsureOptions::new(None, None, None),
        )
        .await;
        assert!(server_refusal.as_ref().is_err_and(is_runtime_limit_refusal));
        let wait = fixture.wait_row(waiting).await?.expect("wait kept");
        assert_eq!(wait.request_source, "user");
        assert_eq!(wait.ensure_request["metadata"]["sizeId"], json!("boost"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn queued_work_behind_a_recently_active_blocker_starts_once_the_blocker_idles(
) -> anyhow::Result<()> {
    // Ten seconds of idleness against the two-minute reclaim window: the
    // blocker's owner is still around when the message is sent.
    let fixture = setup("limit-wait-eventual-launch", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        fixture.queue_job(waiting).await?;

        // Nothing is due yet: the first retry waits one backoff step.
        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(report.attempted, 0, "{report:?}");

        fixture.make_due(waiting).await?;
        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!((report.attempted, report.launched), (1, 0), "{report:?}");
        assert_eq!(fixture.blocker_status().await?, "ready");
        assert!(!fixture.has_launched_runtime(waiting).await?);
        let wait = fixture.wait_row(waiting).await?.expect("still waiting");
        assert_eq!(wait.attempts, 1);
        assert!(!wait.claimed, "an attempt releases its claim");
        assert!((55.0..=61.0).contains(&wait.next_attempt_in), "{wait:?}");

        // The blocker's owner walks away. Once the backoff elapses, the retry
        // takes the idle slot through the ordinary ensure and reclaim.
        fixture.set_blocker_idle_for(3_600).await?;
        fixture.make_due(waiting).await?;
        let _blocker_watch = fixture
            .state
            .events
            .watch_project(fixture.blocker_project_id);
        let _waiting_watch = fixture.state.events.watch_project(waiting);
        let mut events = fixture.state.events.subscribe();

        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!((report.attempted, report.launched), (1, 1), "{report:?}");
        assert_eq!(fixture.blocker_status().await?, "stopped");
        assert!(fixture.has_launched_runtime(waiting).await?);
        assert!(
            fixture.wait_row(waiting).await?.is_none(),
            "a launched space stops waiting"
        );
        assert_eq!(
            fixture.provider_events().await,
            vec!["release", "launch"],
            "the waiting space launches only after the blocker was released"
        );

        // The reclaimed space learns why its machine stopped, durably and on
        // the event its studio listens to.
        let stop_reason: Option<String> = fixture
            .pool
            .get()
            .await?
            .query_one(
                "select data ->> 'reason' as reason from runtime_events
                 where runtime_id = $1 and kind = 'stopped'
                 order by id desc limit 1",
                &[&fixture.blocker_runtime_id],
            )
            .await?
            .get("reason");
        assert_eq!(stop_reason.as_deref(), Some("runtime_limit_reclaim"));
        let events = drain_events(&mut events);
        let stopped = events
            .iter()
            .find(|event| {
                event.kind == "runtime.stopped"
                    && event.project_id == Some(fixture.blocker_project_id)
            })
            .ok_or_else(|| anyhow::anyhow!("no runtime.stopped for the blocker: {events:?}"))?;
        assert_eq!(stopped.data["reason"], json!("runtime_limit_reclaim"));
        assert_eq!(stopped.data["source"], json!("runtime_limit_reclaim"));
        assert_eq!(stopped.data["queuedJobCount"], json!(0));
        assert!(
            events.iter().any(|event| event.kind == "runtime.requested"
                && event.project_id == Some(waiting)),
            "the waiting space's studio is told a machine was requested: {events:?}"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn limit_wait_retries_back_off_and_never_storm() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-backoff", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        fixture.queue_job(waiting).await?;

        let mut delays = Vec::new();
        for _ in 0..5 {
            fixture.make_due(waiting).await?;
            let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
            assert_eq!(report.attempted, 1, "{report:?}");
            // Back-to-back ticks between retries do nothing.
            for _ in 0..3 {
                let idle = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
                assert_eq!(
                    idle.attempted, 0,
                    "a space is retried once per backoff: {idle:?}"
                );
            }
            let wait = fixture.wait_row(waiting).await?.expect("still waiting");
            delays.push(wait.next_attempt_in.round() as i64);
        }
        let wait = fixture.wait_row(waiting).await?.expect("still waiting");
        assert_eq!(wait.attempts, 5);
        // 60, 120, 240, then the five-minute cap (allow a second of rounding).
        let expected = [60, 120, 240, 300, 300];
        for (delay, expected) in delays.iter().zip(expected) {
            assert!(
                (expected - 1..=expected).contains(delay),
                "backoff {delays:?} should follow {expected:?}"
            );
        }
        assert!(
            fixture.provider_events().await.is_empty(),
            "a refused retry never reaches the provider"
        );
        assert_eq!(fixture.blocker_status().await?, "ready");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_sweep_tick_handles_a_bounded_batch_of_waiting_spaces() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-batch", 7, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        for project_id in &fixture.waiting_project_ids {
            fixture.refuse(*project_id).await?;
            fixture.queue_job(*project_id).await?;
            fixture.make_due(*project_id).await?;
        }
        let batch = LimitWaitPolicy {
            batch_size: 5,
            ..policy()
        };

        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &batch).await?;
        assert_eq!((report.claimed, report.attempted), (5, 5), "{report:?}");
        let mut attempts = Vec::new();
        for project_id in &fixture.waiting_project_ids {
            attempts.push(
                fixture
                    .wait_row(*project_id)
                    .await?
                    .expect("waiting")
                    .attempts,
            );
        }
        attempts.sort();
        assert_eq!(attempts, vec![0, 0, 1, 1, 1, 1, 1]);

        // The next tick picks up the two left over, not the five just retried.
        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &batch).await?;
        assert_eq!(report.attempted, 2, "{report:?}");
        for project_id in &fixture.waiting_project_ids {
            assert_eq!(
                fixture
                    .wait_row(*project_id)
                    .await?
                    .expect("waiting")
                    .attempts,
                1
            );
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn waits_without_queued_work_never_crowd_out_the_batch_and_lapse_when_quiet(
) -> anyhow::Result<()> {
    // Opening a space is enough to be refused (the studio auto-ensures), so
    // most recorded waits have nothing queued behind them.
    let fixture = setup("limit-wait-empty-waits", 7, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        for project_id in &fixture.waiting_project_ids {
            fixture.refuse(*project_id).await?;
            fixture.make_due(*project_id).await?;
        }
        let with_work = *fixture.waiting_project_ids.last().expect("seven spaces");
        fixture.queue_job(with_work).await?;
        let batch = LimitWaitPolicy {
            batch_size: 5,
            ..policy()
        };

        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &batch).await?;
        assert_eq!((report.claimed, report.attempted), (1, 1), "{report:?}");
        assert_eq!(
            fixture
                .wait_row(with_work)
                .await?
                .expect("waiting")
                .attempts,
            1
        );

        // An empty wait survives a refusal that races its message's dispatch,
        // then lapses once it has been quiet for the whole window.
        let empty = fixture.waiting_project_ids[0];
        assert!(fixture.wait_row(empty).await?.is_some());
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update hosted_runtime_limit_waits
                 set last_refused_at = now() - interval '31 minutes'
                 where project_id = any($1)",
                &[&fixture.waiting_project_ids],
            )
            .await?;
        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &batch).await?;
        assert_eq!(report.finished_waits, 6, "{report:?}");
        assert!(fixture.wait_row(empty).await?.is_none());
        assert!(
            fixture.wait_row(with_work).await?.is_some(),
            "a space with queued work keeps waiting however old its last refusal"
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_space_claimed_by_another_controller_is_not_retried_twice() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-replicas", 3, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        for project_id in &fixture.waiting_project_ids {
            fixture.refuse(*project_id).await?;
            fixture.queue_job(*project_id).await?;
            fixture.make_due(*project_id).await?;
        }
        // Replica A has claimed every due space and is still working on them.
        let claimed_by_a = claim_due_waits(&fixture.state, &policy(), 3, &[], &[]).await?;
        assert_eq!(claimed_by_a.len(), 3);

        // Replica B, on its own pool, must leave them alone.
        let replica_b = crate::tests::build_test_state(
            crate::tests::require_origin_test_pool("limit-wait-replicas-b").await?,
            fixture.state.config.clone(),
        );
        let report = sweep_hosted_runtime_limit_waits(&replica_b, &policy()).await?;
        assert_eq!((report.claimed, report.attempted), (0, 0), "{report:?}");

        // Replica A died. Its claims expire and B takes the spaces over.
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update hosted_runtime_limit_waits
                 set claimed_until = now() - interval '1 second'
                 where project_id = any($1)",
                &[&fixture.waiting_project_ids],
            )
            .await?;
        let report = sweep_hosted_runtime_limit_waits(&replica_b, &policy()).await?;
        assert_eq!(report.attempted, 3, "{report:?}");
        for project_id in &fixture.waiting_project_ids {
            let wait = fixture.wait_row(*project_id).await?.expect("waiting");
            assert_eq!(wait.attempts, 1);
            assert!(!wait.claimed);
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn work_that_waits_out_the_window_fails_with_a_clear_reason() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-give-up", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        let (old_job, old_run, conversation_id) = fixture.queue_conversation_job(waiting).await?;
        let young_job = fixture.queue_job(waiting).await?;
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs set created_at = now() - interval '31 minutes' where id = $1",
                &[&old_job],
            )
            .await?;
        // The space has been waiting on the limit since then too.
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update hosted_runtime_limit_waits
                 set first_refused_at = now() - interval '31 minutes'
                 where project_id = $1",
                &[&waiting],
            )
            .await?;
        let _watch = fixture.state.events.watch_project(waiting);
        let mut events = fixture.state.events.subscribe();

        // Not due for a retry, but the old job is past the window: the tick
        // claims the space for the give-up alone.
        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(
            (report.expired_jobs, report.attempted),
            (1, 0),
            "{report:?}"
        );

        let (status, outcome, error_message) = fixture.job_state(old_job).await?;
        assert_eq!(status, "failed");
        assert_eq!(outcome.as_deref(), Some("expired"));
        assert_eq!(error_message.as_deref(), Some(LIMIT_WAIT_EXPIRED_MESSAGE));
        assert_eq!(fixture.job_state(young_job).await?.0, "queued");

        let connection = fixture.pool.get().await?;
        let run = connection
            .query_one(
                "select status, last_message from runs where id = $1",
                &[&old_run],
            )
            .await?;
        assert_eq!(run.get::<_, String>("status"), "failed");
        assert_eq!(
            run.get::<_, Option<String>>("last_message").as_deref(),
            Some(LIMIT_WAIT_EXPIRED_MESSAGE)
        );
        let message = connection
            .query_one(
                "select role, content, metadata from conversation_messages
                 where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        assert_eq!(message.get::<_, String>("role"), "assistant");
        assert_eq!(
            message.get::<_, String>("content"),
            LIMIT_WAIT_EXPIRED_MESSAGE
        );
        let metadata = message.get::<_, PgJson<JsonValue>>("metadata").0;
        assert_eq!(metadata["outcome"], json!("failed"));
        assert_eq!(metadata["kind"], json!("runtime_limit_wait_expired"));
        assert_eq!(metadata["jobId"], json!(old_job));
        drop(connection);

        let events = drain_events(&mut events);
        let completed = events
            .iter()
            .find(|event| event.kind == "run.completed" && event.run_id == Some(old_run))
            .ok_or_else(|| anyhow::anyhow!("no run.completed for the expired run: {events:?}"))?;
        assert_eq!(completed.data["runStatus"], json!("failed"));
        assert_eq!(
            completed.data["errorMessage"],
            json!(LIMIT_WAIT_EXPIRED_MESSAGE)
        );

        // The young job still waits, so the space keeps waiting too.
        let wait = fixture.wait_row(waiting).await?.expect("still waiting");
        assert!(!wait.claimed);
        assert_eq!(wait.attempts, 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn only_work_a_hosted_machine_would_run_keeps_a_space_waiting() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-eligibility", 2, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let pinned_elsewhere = fixture.waiting_project_ids[0];
        let already_served = fixture.waiting_project_ids[1];

        // A job pinned to the space's desktop machine waits for that machine.
        fixture.refuse(pinned_elsewhere).await?;
        let desktop_runtime_id = Uuid::new_v4();
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
                 values ($1, $2, 'self_hosted', 'offline', 600)",
                &[&desktop_runtime_id, &pinned_elsewhere],
            )
            .await?;
        connection
            .execute(
                "insert into agent_jobs (project_id, status, payload, target_runtime_id)
                 values ($1, 'queued', '{}'::jsonb, $2)",
                &[&pinned_elsewhere, &desktop_runtime_id],
            )
            .await?;
        fixture.make_due(pinned_elsewhere).await?;

        // A space whose own machine is already launching needs no retry.
        fixture.refuse(already_served).await?;
        fixture.queue_job(already_served).await?;
        fixture.make_due(already_served).await?;
        let lease_id = Uuid::new_v4();
        connection
            .execute(
                "insert into runtime_leases (id, project_id, runtime_id, status)
                 select $1, project_id, id, 'launching' from runtimes
                 where project_id = $2 and provider = $3",
                &[&lease_id, &already_served, &PROVIDER_ID],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where project_id = $1 and provider = $3",
                &[&already_served, &lease_id, &PROVIDER_ID],
            )
            .await?;
        drop(connection);

        // The blocker is idle now, so any retry would reclaim it: none may run.
        fixture.set_blocker_idle_for(3_600).await?;
        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(report.attempted, 0, "{report:?}");
        assert_eq!(fixture.blocker_status().await?, "ready");
        assert!(fixture.provider_events().await.is_empty());
        assert!(
            fixture.wait_row(already_served).await?.is_none(),
            "a space with a live machine stops waiting"
        );
        let wait = fixture.wait_row(pinned_elsewhere).await?.expect("kept");
        assert!(!wait.claimed);
        Ok(())
    })
    .await
}

/// A refusal whose text is operator detail (here "provider '...' is not
/// configured on this controller") ends the wait and fails the work at once,
/// but the conversation, which everyone in the space reads, gets the plain
/// reason rather than that text.
#[tokio::test]
async fn a_launch_refused_for_another_reason_fails_the_waiting_work_with_a_plain_reason(
) -> anyhow::Result<()> {
    let fixture = setup("limit-wait-other-refusal", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        let (job_id, run_id, conversation_id) = fixture.queue_conversation_job(waiting).await?;
        // The provider was removed from this controller since the refusal.
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update hosted_runtime_limit_waits
                 set ensure_request = jsonb_set(ensure_request, '{provider}', '\"instafy_cloud_gone\"')
                 where project_id = $1",
                &[&waiting],
            )
            .await?;
        fixture.make_due(waiting).await?;

        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(
            (report.attempted, report.refused_jobs, report.launched),
            (1, 1, 0),
            "{report:?}"
        );
        assert!(fixture.wait_row(waiting).await?.is_none());
        // Waiting could not fix it, so the job fails now instead of staying
        // queued behind a wait that is over.
        let (status, outcome, error_message) = fixture.job_state(job_id).await?;
        assert_eq!(status, "failed");
        assert_eq!(outcome.as_deref(), Some("failed"));
        assert_eq!(
            error_message.as_deref(),
            Some(LIMIT_WAIT_REFUSED_FALLBACK_MESSAGE)
        );
        let connection = fixture.pool.get().await?;
        let run = connection
            .query_one(
                "select status, last_message from runs where id = $1",
                &[&run_id],
            )
            .await?;
        assert_eq!(run.get::<_, String>("status"), "failed");
        assert_eq!(
            run.get::<_, Option<String>>("last_message").as_deref(),
            Some(LIMIT_WAIT_REFUSED_FALLBACK_MESSAGE)
        );
        let message = connection
            .query_one(
                "select content, metadata from conversation_messages
                 where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        assert_eq!(
            message.get::<_, String>("content"),
            LIMIT_WAIT_REFUSED_FALLBACK_MESSAGE
        );
        let metadata = message.get::<_, PgJson<JsonValue>>("metadata").0;
        assert_eq!(metadata["kind"], json!("runtime_limit_wait_refused"));
        assert!(
            !metadata.to_string().contains("instafy_cloud_gone"),
            "internal refusal text reached the conversation: {metadata}"
        );
        Ok(())
    })
    .await
}

/// A recorded request nothing can replay (damaged, or written by a controller
/// this one cannot read) must not leave its work queued with nothing left to
/// start it: the work fails at once with the plain reason, through the
/// give-up's path, and the wait ends.
#[tokio::test]
async fn an_unreadable_recorded_request_fails_the_waiting_work_with_a_plain_reason(
) -> anyhow::Result<()> {
    let fixture = setup("limit-wait-unreadable-request", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        let (job_id, run_id, conversation_id) = fixture.queue_conversation_job(waiting).await?;
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update hosted_runtime_limit_waits set ensure_request = '{}'::jsonb
                 where project_id = $1",
                &[&waiting],
            )
            .await?;
        fixture.make_due(waiting).await?;
        let _watch = fixture.state.events.watch_project(waiting);
        let mut events = fixture.state.events.subscribe();

        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(
            (
                report.claimed,
                report.attempted,
                report.refused_jobs,
                report.finished_waits
            ),
            (1, 0, 1, 1),
            "{report:?}"
        );
        assert!(fixture.provider_events().await.is_empty());
        assert!(
            fixture.wait_row(waiting).await?.is_none(),
            "a wait nothing can replay ends"
        );

        let (status, outcome, error_message) = fixture.job_state(job_id).await?;
        assert_eq!(
            status, "failed",
            "the unreplayable wait's work stayed queued"
        );
        assert_eq!(outcome.as_deref(), Some("failed"));
        assert_eq!(
            error_message.as_deref(),
            Some(LIMIT_WAIT_REFUSED_FALLBACK_MESSAGE)
        );
        let connection = fixture.pool.get().await?;
        let run = connection
            .query_one("select status from runs where id = $1", &[&run_id])
            .await?;
        assert_eq!(run.get::<_, String>("status"), "failed");
        let message = connection
            .query_one(
                "select role, content, metadata from conversation_messages
                 where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        assert_eq!(message.get::<_, String>("role"), "assistant");
        assert_eq!(
            message.get::<_, String>("content"),
            LIMIT_WAIT_REFUSED_FALLBACK_MESSAGE
        );
        let metadata = message.get::<_, PgJson<JsonValue>>("metadata").0;
        assert_eq!(metadata["kind"], json!("runtime_limit_wait_refused"));
        assert_eq!(metadata["outcome"], json!("failed"));
        assert_eq!(metadata["jobId"], json!(job_id));
        drop(connection);

        let events = drain_events(&mut events);
        let completed = events
            .iter()
            .find(|event| event.kind == "run.completed" && event.run_id == Some(run_id))
            .ok_or_else(|| anyhow::anyhow!("no run.completed for the failed run: {events:?}"))?;
        assert_eq!(completed.data["runStatus"], json!("failed"));
        assert_eq!(
            completed.data["errorMessage"],
            json!(LIMIT_WAIT_REFUSED_FALLBACK_MESSAGE)
        );
        Ok(())
    })
    .await
}

/// A credits refusal is final for the retry: the work fails at once with the
/// credits reason, through the same path as the give-up (run, conversation,
/// run.completed), instead of staying queued with its reserve held while the
/// studio promises it will send.
#[tokio::test]
async fn a_credits_refusal_fails_the_waiting_work_with_the_credits_reason() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-credits-refusal", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        let (job_id, run_id, conversation_id) = fixture.queue_conversation_job(waiting).await?;
        let young_job_id = fixture.queue_job(waiting).await?;

        // The slot frees up, but the team has run out of credits since.
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "update runtime_leases set released_at = now(), status = 'released'
                 where id = $1",
                &[&fixture.blocker_lease_id],
            )
            .await?;
        connection
            .execute(
                "update runtimes set status = 'stopped', active_lease_id = null where id = $1",
                &[&fixture.blocker_runtime_id],
            )
            .await?;
        connection
            .execute(
                "insert into org_credit_balances (org_id, balance, credit_limit)
                 values ($1, 0, 0)
                 on conflict (org_id) do update set balance = 0, credit_limit = 0",
                &[&fixture.org_id],
            )
            .await?;
        drop(connection);
        fixture.make_due(waiting).await?;

        // More than the team's whole daily allowance, so even today's refill
        // could not pay for the machine.
        let mut config = fixture.state.config.clone();
        config.hosted_runtime_credit_burn_amount = 100_000;
        let state = crate::tests::build_test_state(fixture.pool.clone(), config);
        let _watch = state.events.watch_project(waiting);
        let mut events = state.events.subscribe();

        let report = sweep_hosted_runtime_limit_waits(&state, &policy()).await?;
        assert_eq!(
            (report.attempted, report.launched, report.refused_jobs),
            (1, 0, 2),
            "{report:?}"
        );
        assert!(fixture.provider_events().await.is_empty());
        assert!(
            fixture.wait_row(waiting).await?.is_none(),
            "a refusal waiting cannot fix ends the wait"
        );

        for job in [job_id, young_job_id] {
            let (status, outcome, error_message) = fixture.job_state(job).await?;
            assert_eq!(status, "failed");
            assert_eq!(outcome.as_deref(), Some("failed"));
            let error_message = error_message.unwrap_or_default();
            assert!(
                error_message.starts_with("This team is out of credits"),
                "the credits refusal's own reason: {error_message}"
            );
        }
        let (_, _, reason) = fixture.job_state(job_id).await?;
        let reason = reason.unwrap_or_default();

        let connection = fixture.pool.get().await?;
        let run = connection
            .query_one(
                "select status, last_message from runs where id = $1",
                &[&run_id],
            )
            .await?;
        assert_eq!(run.get::<_, String>("status"), "failed");
        assert_eq!(
            run.get::<_, Option<String>>("last_message").as_deref(),
            Some(reason.as_str())
        );
        let message = connection
            .query_one(
                "select role, content, metadata from conversation_messages
                 where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        assert_eq!(message.get::<_, String>("role"), "assistant");
        assert_eq!(message.get::<_, String>("content"), reason);
        let metadata = message.get::<_, PgJson<JsonValue>>("metadata").0;
        assert_eq!(metadata["kind"], json!("runtime_limit_wait_refused"));
        assert_eq!(metadata["outcome"], json!("failed"));
        assert_eq!(metadata["jobId"], json!(job_id));
        drop(connection);

        let events = drain_events(&mut events);
        let completed = events
            .iter()
            .find(|event| event.kind == "run.completed" && event.run_id == Some(run_id))
            .ok_or_else(|| anyhow::anyhow!("no run.completed for the refused run: {events:?}"))?;
        assert_eq!(completed.data["runStatus"], json!("failed"));
        assert_eq!(completed.data["outcome"], json!("failed"));
        assert_eq!(completed.data["errorMessage"], json!(reason));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn the_give_up_clock_starts_when_the_space_began_waiting_on_the_limit() -> anyhow::Result<()>
{
    let fixture = setup("limit-wait-give-up-clock", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        // The message sat behind the space's own busy machine for most of an
        // hour; only now is the space refused a new machine.
        let job_id = fixture.queue_job(waiting).await?;
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs set created_at = now() - interval '50 minutes' where id = $1",
                &[&job_id],
            )
            .await?;
        fixture.refuse(waiting).await?;

        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(report.expired_jobs, 0, "{report:?}");
        assert_eq!(fixture.job_state(job_id).await?.0, "queued");

        // Retries that keep failing for another reason are still the same
        // wait: a later limit refusal must not restart the clock.
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update hosted_runtime_limit_waits
                 set first_refused_at = now() - interval '31 minutes',
                     last_refused_at = now() - interval '31 minutes',
                     last_attempt_at = now() - interval '2 minutes',
                     attempts = 6
                 where project_id = $1",
                &[&waiting],
            )
            .await?;
        fixture.refuse(waiting).await?;
        let wait = fixture.wait_row(waiting).await?.expect("still waiting");
        assert_eq!(
            wait.attempts, 6,
            "an active wait keeps its backoff: {wait:?}"
        );

        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(report.expired_jobs, 1, "{report:?}");
        let (status, outcome, error_message) = fixture.job_state(job_id).await?;
        assert_eq!(status, "failed");
        assert_eq!(outcome.as_deref(), Some("expired"));
        assert_eq!(error_message.as_deref(), Some(LIMIT_WAIT_EXPIRED_MESSAGE));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_quarantined_generation_does_not_end_the_wait() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-quarantined", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        let job_id = fixture.queue_job(waiting).await?;
        fixture.make_due(waiting).await?;
        // The space's own generation is stuck behind a failed provider
        // release: it holds a lease, but it will never run the job.
        let lease_id = Uuid::new_v4();
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "insert into runtime_leases (id, project_id, runtime_id, status)
                 select $1, project_id, id, 'cleanup_pending' from runtimes
                 where project_id = $2 and provider = $3",
                &[&lease_id, &waiting, &PROVIDER_ID],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where project_id = $1 and provider = $3",
                &[&waiting, &lease_id, &PROVIDER_ID],
            )
            .await?;
        drop(connection);

        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!((report.attempted, report.launched), (1, 0), "{report:?}");
        let wait = fixture
            .wait_row(waiting)
            .await?
            .ok_or_else(|| anyhow::anyhow!("a quarantined generation is not a live runtime"))?;
        assert_eq!(wait.attempts, 1);
        assert!(!wait.claimed);
        assert_eq!(fixture.job_state(job_id).await?.0, "queued");
        Ok(())
    })
    .await
}

/// A message that never ran must not cost anything: giving up on it hands the
/// managed-AI reserve dispatch took for it back, exactly once.
#[tokio::test]
async fn giving_up_refunds_the_managed_ai_reserve_of_a_message_that_never_ran() -> anyhow::Result<()>
{
    use crate::tests_managed_ai_refund::{
        credit_balance, ledger_rows, prompt_metadata, run_row, seed_reserved_managed_ai_prompt,
    };
    use futures_util::FutureExt;

    let fixture = seed_reserved_managed_ai_prompt("limit-wait-refund")
        .await?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "limit-wait-refund requires TEST_DATABASE_URL; run it through `pnpm test:controller`"
            )
        })?;
    let body = async {
        let connection = fixture.pool.get().await?;
        // The space waited out the window on the limit.
        connection
            .execute(
                "insert into hosted_runtime_limit_waits
                    (project_id, ensure_request, first_refused_at, last_refused_at,
                     next_attempt_at, last_error_code)
                 values ($1, '{}'::jsonb, now() - interval '31 minutes', now(),
                         now() + interval '1 hour', 'runtime_limit_reached')",
                &[&fixture.project_id],
            )
            .await?;
        connection
            .execute(
                "update agent_jobs set created_at = now() - interval '31 minutes' where id = $1",
                &[&fixture.job_id],
            )
            .await?;
        drop(connection);

        let _watch = fixture.state.events.watch_project(fixture.project_id);
        let mut events = fixture.state.events.subscribe();
        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(
            (report.expired_jobs, report.attempted),
            (1, 0),
            "{report:?}"
        );
        assert_eq!(
            crate::tests::queued_credit_signals(&mut events, fixture.project_id),
            1,
            "the refund is signalled once the give-up commits"
        );

        let refund_key = format!("managed-ai-refund:{}", fixture.prompt_id);
        let refunds = ledger_rows(&fixture.pool, &fixture.project_id)
            .await?
            .into_iter()
            .filter(|(reason, delta, key)| {
                reason == "managed_ai_refund"
                    && *delta == fixture.burn_amount
                    && key.as_deref() == Some(refund_key.as_str())
            })
            .count();
        assert_eq!(refunds, 1);
        let restored = fixture.reserved_balance + fixture.burn_amount;
        assert_eq!(
            credit_balance(&fixture.pool, &fixture.org_id).await?,
            restored
        );
        assert_eq!(
            prompt_metadata(&fixture.pool, &fixture.prompt_id).await?["managedAiUsed"],
            json!(false)
        );
        let (run_status, _) = run_row(&fixture.pool, &fixture.run_id).await?;
        assert_eq!(run_status, "failed");

        // Nothing is left to give up on, and nothing is refunded twice.
        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(report.expired_jobs, 0, "{report:?}");
        assert_eq!(
            credit_balance(&fixture.pool, &fixture.org_id).await?,
            restored
        );
        Ok(())
    };
    let outcome = std::panic::AssertUnwindSafe(body).catch_unwind().await;
    let cleanup = fixture.cleanup().await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// The retry must not hold a pool slot while the launch it replays waits on
/// the provider. The launch itself pins exactly one (its row guard across
/// `/runtime/ensure`, see `slow_provider_ensure_pins_at_most_one_pool_connection`),
/// so with two slots the rest of the controller must still get one.
#[tokio::test]
async fn a_retry_holds_no_pool_connection_while_the_provider_launches() -> anyhow::Result<()> {
    use tokio::sync::Notify;

    let fixture = setup("limit-wait-connection-hygiene", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        fixture.queue_job(waiting).await?;
        fixture.make_due(waiting).await?;
        fixture.set_blocker_idle_for(3_600).await?;

        let ensure_reached = Arc::new(Notify::new());
        let ensure_respond = Arc::new(Notify::new());
        let provider_app = axum::Router::new()
            .route(
                "/runtime/ensure",
                axum::routing::post({
                    let ensure_reached = ensure_reached.clone();
                    let ensure_respond = ensure_respond.clone();
                    move || {
                        let ensure_reached = ensure_reached.clone();
                        let ensure_respond = ensure_respond.clone();
                        async move {
                            ensure_reached.notify_one();
                            ensure_respond.notified().await;
                            Json(json!({ "message": "runtime ensured" }))
                        }
                    }
                }),
            )
            .route(
                "/runtime/release",
                axum::routing::post(|| async { StatusCode::NO_CONTENT }),
            );
        let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let provider_address = provider_listener.local_addr()?;
        let _provider_server = crate::tests::spawn_aborting(async move {
            axum::serve(provider_listener, provider_app)
                .await
                .expect("serve slow limit wait provider");
        });

        let mut config = fixture.state.config.clone();
        for provider in &mut config.runtime_providers {
            provider.endpoint = Some(format!("http://{provider_address}"));
        }
        let pool = crate::tests::require_origin_test_pool_with_max_size(
            "limit wait connection hygiene test",
            2,
        )
        .await?;
        let state = crate::tests::build_test_state(pool.clone(), config);

        let sweep = crate::tests::spawn_aborting({
            let state = state.clone();
            async move { sweep_hosted_runtime_limit_waits(&state, &policy()).await }
        });
        tokio::time::timeout(Duration::from_secs(10), ensure_reached.notified())
            .await
            .expect("the retry never reached the provider");

        let probe = tokio::time::timeout(Duration::from_secs(2), pool.get())
            .await
            .expect("the retry kept a pool connection checked out across the provider launch")?;
        probe.query_one("select 1", &[]).await?;
        drop(probe);

        ensure_respond.notify_one();
        let report = tokio::time::timeout(Duration::from_secs(10), sweep)
            .await
            .expect("the retry did not finish after the provider answered")??;
        assert_eq!((report.attempted, report.launched), (1, 1), "{report:?}");
        assert!(fixture.has_launched_runtime(waiting).await?);
        Ok(())
    })
    .await
}

/// A private connection outside every pool, for a test that plays another
/// replica holding a lock mid-transaction. Dropping the client rolls back.
async fn raw_client() -> anyhow::Result<(tokio_postgres::Client, tokio::task::JoinHandle<()>)> {
    let url = std::env::var("TEST_DATABASE_URL")
        .context("this test requires TEST_DATABASE_URL; run it through `pnpm test:controller`")?;
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await?;
    let driver = tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok((client, driver))
}

async fn hosted_runtime_id(pool: &crate::config::PgPool, project_id: Uuid) -> anyhow::Result<Uuid> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select id from runtimes where project_id = $1 and provider = $2",
            &[&project_id, &PROVIDER_ID],
        )
        .await?
        .get("id"))
}

/// A heartbeating desktop in the space, private to `owner`.
async fn add_heartbeating_desktop(
    pool: &crate::config::PgPool,
    project_id: Uuid,
    owner: Uuid,
) -> anyhow::Result<Uuid> {
    let runtime_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into runtimes
                (id, project_id, provider, status, idle_ttl_seconds, last_seen_at, capabilities)
             values ($1, $2, 'self_hosted', 'ready', 600, now(), $3)",
            &[
                &runtime_id,
                &project_id,
                &json!({
                    "_instafySelfHostedAccess": {
                        "mode": "private",
                        "ownerUserId": owner.to_string(),
                    }
                }),
            ],
        )
        .await?;
    Ok(runtime_id)
}

/// A desktop (or any machine) that is up does not end a wait for work it
/// would never run: a job pinned to the space's hosted runtime, or unpinned
/// work of another user. The retry and the give-up go on for those. Work the
/// desktop does run (unpinned, its owner's) ends the wait.
#[tokio::test]
async fn a_heartbeating_desktop_only_ends_a_wait_for_work_it_would_run() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-desktop", 3, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let pinned_to_hosted = fixture.waiting_project_ids[0];
        let another_users_work = fixture.waiting_project_ids[1];
        let owners_work = fixture.waiting_project_ids[2];
        let owner = Uuid::new_v4();
        let someone_else = Uuid::new_v4();

        for project_id in &fixture.waiting_project_ids {
            fixture.refuse(*project_id).await?;
            add_heartbeating_desktop(&fixture.pool, *project_id, owner).await?;
        }
        let connection = fixture.pool.get().await?;
        let pinned_job = Uuid::new_v4();
        connection
            .execute(
                "insert into agent_jobs (id, project_id, status, payload, target_runtime_id)
                 values ($1, $2, 'queued', jsonb_build_object('user_id', $3::text), $4)",
                &[
                    &pinned_job,
                    &pinned_to_hosted,
                    &owner.to_string(),
                    &hosted_runtime_id(&fixture.pool, pinned_to_hosted).await?,
                ],
            )
            .await?;
        let others_job = Uuid::new_v4();
        let owners_job = Uuid::new_v4();
        for (job_id, project_id, user_id) in [
            (others_job, another_users_work, someone_else),
            (owners_job, owners_work, owner),
        ] {
            connection
                .execute(
                    "insert into agent_jobs (id, project_id, status, payload)
                     values ($1, $2, 'queued', jsonb_build_object('user_id', $3::text))",
                    &[&job_id, &project_id, &user_id.to_string()],
                )
                .await?;
        }
        drop(connection);
        for project_id in &fixture.waiting_project_ids {
            fixture.make_due(*project_id).await?;
        }

        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(report.attempted, 2, "{report:?}");
        for project_id in [pinned_to_hosted, another_users_work] {
            let wait = fixture
                .wait_row(project_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("a desktop must not end this wait"))?;
            assert_eq!(wait.attempts, 1, "{wait:?}");
        }
        assert!(
            fixture.wait_row(owners_work).await?.is_none(),
            "the owner's desktop takes the owner's unpinned work"
        );

        // Past the window, the give-up does not count the desktop either.
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "update agent_jobs set created_at = now() - interval '31 minutes'
                 where id = any($1)",
                &[&vec![pinned_job, others_job, owners_job]],
            )
            .await?;
        connection
            .execute(
                "update hosted_runtime_limit_waits
                 set first_refused_at = now() - interval '31 minutes'
                 where project_id = any($1)",
                &[&fixture.waiting_project_ids],
            )
            .await?;
        drop(connection);
        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(report.expired_jobs, 2, "{report:?}");
        assert_eq!(fixture.job_state(pinned_job).await?.0, "failed");
        assert_eq!(fixture.job_state(others_job).await?.0, "failed");
        assert_eq!(
            fixture.job_state(owners_job).await?.0,
            "queued",
            "work a live desktop runs is not given up on"
        );
        Ok(())
    })
    .await
}

/// Work an idle-slot reclaim requeued waits on the limit like any other: the
/// older 15-minute requeued-job expiry leaves it to the limit wait, whose
/// give-up fails it after its own window and refunds the reserve of a job that
/// never ran.
#[tokio::test]
async fn requeued_work_in_a_waiting_space_is_given_up_by_the_limit_wait_and_refunded(
) -> anyhow::Result<()> {
    use crate::tests_managed_ai_refund::{
        credit_balance, ledger_rows, seed_reserved_managed_ai_prompt,
    };
    use futures_util::FutureExt;

    let fixture = seed_reserved_managed_ai_prompt("limit-wait-requeued-expiry")
        .await?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "limit-wait-requeued-expiry requires TEST_DATABASE_URL; run it through `pnpm test:controller`"
            )
        })?;
    let body = async {
        let connection = fixture.pool.get().await?;
        // The reclaim stopped the space's machine and requeued the job 20
        // minutes ago; the space has waited on the limit since.
        connection
            .execute(
                "update runtimes set status = 'stopped' where project_id = $1",
                &[&fixture.project_id],
            )
            .await?;
        connection
            .execute(
                "update agent_jobs
                 set payload = payload || jsonb_build_object(
                       'requeuedAt', (now() - interval '20 minutes')::text,
                       'requeuedReason', 'runtime_limit_reclaim')
                 where id = $1",
                &[&fixture.job_id],
            )
            .await?;
        connection
            .execute(
                "insert into hosted_runtime_limit_waits
                    (project_id, ensure_request, first_refused_at, last_refused_at,
                     next_attempt_at, last_error_code)
                 values ($1, '{}'::jsonb, now() - interval '20 minutes', now(),
                         now() + interval '1 hour', 'runtime_limit_reached')",
                &[&fixture.project_id],
            )
            .await?;
        drop(connection);

        crate::runtime::sweeps::expire_stale_requeued_jobs(&fixture.state).await?;
        let job_status: String = fixture
            .pool
            .get()
            .await?
            .query_one(
                "select status from agent_jobs where id = $1",
                &[&fixture.job_id],
            )
            .await?
            .get("status");
        assert_eq!(
            job_status, "queued",
            "the requeued-job expiry leaves a space waiting on the limit alone"
        );

        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "update agent_jobs
                 set payload = payload || jsonb_build_object(
                       'requeuedAt', (now() - interval '31 minutes')::text)
                 where id = $1",
                &[&fixture.job_id],
            )
            .await?;
        connection
            .execute(
                "update hosted_runtime_limit_waits
                 set first_refused_at = now() - interval '31 minutes'
                 where project_id = $1",
                &[&fixture.project_id],
            )
            .await?;
        drop(connection);
        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(report.expired_jobs, 1, "{report:?}");
        let row = fixture
            .pool
            .get()
            .await?
            .query_one(
                "select status, error_message from agent_jobs where id = $1",
                &[&fixture.job_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("status"), "failed");
        assert_eq!(
            row.get::<_, Option<String>>("error_message").as_deref(),
            Some(LIMIT_WAIT_EXPIRED_MESSAGE)
        );
        let refund_key = format!("managed-ai-refund:{}", fixture.prompt_id);
        let refunds = ledger_rows(&fixture.pool, &fixture.project_id)
            .await?
            .into_iter()
            .filter(|(reason, delta, key)| {
                reason == "managed_ai_refund"
                    && *delta == fixture.burn_amount
                    && key.as_deref() == Some(refund_key.as_str())
            })
            .count();
        assert_eq!(refunds, 1, "a job that never ran gets its reserve back");
        assert_eq!(
            credit_balance(&fixture.pool, &fixture.org_id).await?,
            fixture.reserved_balance + fixture.burn_amount
        );
        Ok(())
    };
    let outcome = std::panic::AssertUnwindSafe(body).catch_unwind().await;
    let cleanup = fixture.cleanup().await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// The requeued-job expiry leaves to a space's limit wait only the work that
/// wait covers. Requeued work pinned to the space's desktop, which the wait
/// never retries or gives up on, still expires after 15 minutes while the
/// space waits on the limit for its hosted work.
#[tokio::test]
async fn requeued_work_the_limit_wait_does_not_cover_still_expires() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-requeued-pinned-elsewhere", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        let hosted_runtime = hosted_runtime_id(&fixture.pool, waiting).await?;
        let desktop_runtime = Uuid::new_v4();
        let connection = fixture.pool.get().await?;
        // Every machine of the space is down: the hosted one was reclaimed
        // and the desktop is offline.
        connection
            .execute(
                "update runtimes set status = 'stopped' where project_id = $1",
                &[&waiting],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
                 values ($1, $2, 'self_hosted', 'offline', 600)",
                &[&desktop_runtime, &waiting],
            )
            .await?;
        let (unpinned, pinned_to_hosted, pinned_to_desktop) =
            (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        for (job_id, target) in [
            (unpinned, None),
            (pinned_to_hosted, Some(hosted_runtime)),
            (pinned_to_desktop, Some(desktop_runtime)),
        ] {
            connection
                .execute(
                    "insert into agent_jobs (id, project_id, status, payload, target_runtime_id)
                     values ($1, $2, 'queued',
                             jsonb_build_object(
                               'requeuedAt', (now() - interval '20 minutes')::text,
                               'requeuedReason', 'runtime_limit_reclaim'),
                             $3)",
                    &[&job_id, &waiting, &target],
                )
                .await?;
        }
        drop(connection);

        crate::runtime::sweeps::expire_stale_requeued_jobs(&fixture.state).await?;
        let (status, outcome, error_message) = fixture.job_state(pinned_to_desktop).await?;
        assert_eq!(
            status, "failed",
            "work the limit wait never settles must not wait on it"
        );
        assert_eq!(outcome.as_deref(), Some("expired"));
        let error_message = error_message.unwrap_or_default();
        assert!(
            error_message.starts_with("This run was interrupted"),
            "{error_message}"
        );
        for job_id in [unpinned, pinned_to_hosted] {
            assert_eq!(
                fixture.job_state(job_id).await?.0,
                "queued",
                "work the limit wait covers is left to its give-up"
            );
        }
        Ok(())
    })
    .await
}

/// Two replicas launching for two spaces of one organization at once must not
/// both take its last hosted slot. Replica A has counted a free slot and
/// inserted its lease but not committed; replica B's ensure has to wait for
/// that decision and then sees the slot taken.
#[tokio::test]
async fn the_organization_limit_admits_one_launch_at_a_time_across_replicas() -> anyhow::Result<()>
{
    let fixture = setup("limit-wait-admission-lock", 2, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let (first, second) = (
            fixture.waiting_project_ids[0],
            fixture.waiting_project_ids[1],
        );
        // The blocker's machine is gone: one slot is free.
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "update runtime_leases set released_at = now(), status = 'released'
                 where id = $1",
                &[&fixture.blocker_lease_id],
            )
            .await?;
        connection
            .execute(
                "update runtimes set status = 'stopped', active_lease_id = null where id = $1",
                &[&fixture.blocker_runtime_id],
            )
            .await?;
        drop(connection);

        let first_runtime = hosted_runtime_id(&fixture.pool, first).await?;
        let (replica_a, _driver) = raw_client().await?;
        replica_a.batch_execute("begin").await?;
        replica_a
            .query_one(
                "select pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&crate::runtime::ensure::hosted_runtime_admission_lock_key(
                    &fixture.org_id,
                )],
            )
            .await?;
        let lease_id = Uuid::new_v4();
        replica_a
            .execute(
                "insert into runtime_leases (id, project_id, runtime_id, status, launched_at)
                 values ($1, $2, $3, 'active', now())",
                &[&lease_id, &first, &first_runtime],
            )
            .await?;
        replica_a
            .execute(
                "update runtimes set status = 'ready', active_lease_id = $2 where id = $1",
                &[&first_runtime, &lease_id],
            )
            .await?;

        let replica_b = crate::tests::spawn_aborting({
            let state = fixture.state.clone();
            async move {
                ensure_runtime_launch_recording_limit_wait(
                    &state,
                    LimitWaitSource::User,
                    second,
                    None,
                    PROVIDER_ID.to_string(),
                    600,
                    Some(HOSTED_DISPLAY_NAME.to_string()),
                    None,
                    RuntimeLeaseScope::Exclusive,
                    OriginEnsureOptions::new(None, None, None),
                )
                .await
            }
        });
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert!(
            !replica_b.is_finished(),
            "replica B decided on the organization limit while replica A's admission was open"
        );

        replica_a.batch_execute("commit").await?;
        let result = tokio::time::timeout(Duration::from_secs(20), replica_b)
            .await
            .expect("replica B never finished after replica A committed")?;
        let error = result
            .err()
            .ok_or_else(|| anyhow::anyhow!("replica B launched past the organization limit"))?;
        assert!(
            is_runtime_limit_refusal(&error),
            "expected runtime_limit_reached, got {} {:?}",
            error.0,
            error.1 .0.code
        );
        assert!(fixture.provider_events().await.is_empty());
        assert!(!fixture.has_launched_runtime(second).await?);
        Ok(())
    })
    .await
}

/// Whether another connection could take `org_id`'s admission lock now.
async fn admission_lock_is_free(org_id: Uuid) -> anyhow::Result<bool> {
    let (client, driver) = raw_client().await?;
    client.batch_execute("begin").await?;
    let free: bool = client
        .query_one(
            "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as free",
            &[&crate::runtime::ensure::hosted_runtime_admission_lock_key(
                &org_id,
            )],
        )
        .await?
        .get("free");
    client.batch_execute("rollback").await?;
    drop(client);
    driver.abort();
    Ok(free)
}

/// The organization's admission lock covers database work only. While the
/// provider stops the machine a reclaim takes the slot from, and while it
/// launches the waiting space's machine, any other replica can take it: held
/// across either call, one slow provider would stall every launch in the
/// organization.
#[tokio::test]
async fn the_admission_lock_is_free_while_the_provider_releases_and_launches() -> anyhow::Result<()>
{
    use tokio::sync::Notify;

    // The blocker has been idle for an hour, so the ensure reclaims its slot.
    let fixture = setup("limit-wait-admission-lock-scope", 1, 3_600).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
        let release_gate = Arc::new(Notify::new());
        let launch_gate = Arc::new(Notify::new());
        let provider_app = axum::Router::new()
            .route(
                "/runtime/ensure",
                axum::routing::post({
                    let entered = entered_tx.clone();
                    let gate = launch_gate.clone();
                    move || {
                        let entered = entered.clone();
                        let gate = gate.clone();
                        async move {
                            let _ = entered.send("launch");
                            gate.notified().await;
                            Json(json!({ "message": "runtime ensured" }))
                        }
                    }
                }),
            )
            .route(
                "/runtime/release",
                axum::routing::post({
                    let entered = entered_tx.clone();
                    let gate = release_gate.clone();
                    move || {
                        let entered = entered.clone();
                        let gate = gate.clone();
                        async move {
                            let _ = entered.send("release");
                            gate.notified().await;
                            StatusCode::NO_CONTENT
                        }
                    }
                }),
            );
        let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let provider_address = provider_listener.local_addr()?;
        let _provider_server = crate::tests::spawn_aborting(async move {
            axum::serve(provider_listener, provider_app)
                .await
                .expect("serve gated limit wait provider");
        });
        let mut config = fixture.state.config.clone();
        for provider in &mut config.runtime_providers {
            provider.endpoint = Some(format!("http://{provider_address}"));
        }
        let state = crate::tests::build_test_state(fixture.pool.clone(), config);
        assert!(admission_lock_is_free(fixture.org_id).await?);

        let ensure = crate::tests::spawn_aborting({
            let state = state.clone();
            async move {
                ensure_runtime_launch_recording_limit_wait(
                    &state,
                    LimitWaitSource::User,
                    waiting,
                    None,
                    PROVIDER_ID.to_string(),
                    600,
                    Some(HOSTED_DISPLAY_NAME.to_string()),
                    None,
                    RuntimeLeaseScope::Exclusive,
                    OriginEnsureOptions::new(None, None, None),
                )
                .await
            }
        });
        for (call, gate) in [("release", &release_gate), ("launch", &launch_gate)] {
            let entered = tokio::time::timeout(Duration::from_secs(20), entered_rx.recv())
                .await
                .map_err(|_| anyhow::anyhow!("the ensure never reached the provider {call}"))?;
            assert_eq!(entered, Some(call));
            assert!(
                admission_lock_is_free(fixture.org_id).await?,
                "the admission lock was held across the provider {call}"
            );
            gate.notify_one();
        }
        tokio::time::timeout(Duration::from_secs(20), ensure)
            .await
            .map_err(|_| anyhow::anyhow!("the ensure never finished after the provider answered"))??
            .map_err(|(status, Json(error))| anyhow::anyhow!("{status}: {}", error.message))?;
        assert_eq!(fixture.blocker_status().await?, "stopped");
        assert!(fixture.has_launched_runtime(waiting).await?);
        assert!(admission_lock_is_free(fixture.org_id).await?);
        Ok(())
    })
    .await
}

/// A row another replica is in the middle of claiming is skipped, not
/// waited on: the claim takes every other due space at once.
#[tokio::test]
async fn a_claim_skips_a_row_another_replica_is_claiming() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-skip-locked", 8, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        for project_id in &fixture.waiting_project_ids {
            fixture.refuse(*project_id).await?;
            fixture.queue_job(*project_id).await?;
            fixture.make_due(*project_id).await?;
        }
        let (other_replica, _driver) = raw_client().await?;
        other_replica.batch_execute("begin").await?;
        other_replica
            .query_one(
                "select project_id from hosted_runtime_limit_waits
                 where project_id = $1 for update",
                &[&fixture.waiting_project_ids[0]],
            )
            .await?;
        let claimed = tokio::time::timeout(
            Duration::from_secs(5),
            claim_due_waits(&fixture.state, &policy(), 8, &[], &[]),
        )
        .await
        .expect("a claim waited on a row another replica was claiming")?;
        let claimed: std::collections::BTreeSet<Uuid> =
            claimed.iter().map(|claim| claim.project_id).collect();
        assert_eq!(claimed.len(), 7);
        assert!(!claimed.contains(&fixture.waiting_project_ids[0]));
        other_replica.batch_execute("rollback").await?;
        Ok(())
    })
    .await
}

/// Several replicas claiming at the same moment, each on its own pool, never
/// share a space: every due wait goes to exactly one of them.
#[tokio::test]
async fn concurrent_claims_from_several_replicas_never_share_a_space() -> anyhow::Result<()> {
    const REPLICAS: usize = 4;
    const ROUNDS: usize = 12;
    let fixture = setup("limit-wait-concurrent-claims", 8, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        for project_id in &fixture.waiting_project_ids {
            fixture.refuse(*project_id).await?;
            fixture.queue_job(*project_id).await?;
            fixture.make_due(*project_id).await?;
        }
        let expected: std::collections::BTreeSet<Uuid> =
            fixture.waiting_project_ids.iter().copied().collect();

        let mut replicas = Vec::new();
        for index in 0..REPLICAS {
            replicas.push(crate::tests::build_test_state(
                crate::tests::require_origin_test_pool(&format!("limit-wait-replica-{index}"))
                    .await?,
                fixture.state.config.clone(),
            ));
        }
        for round in 0..ROUNDS {
            fixture
                .pool
                .get()
                .await?
                .execute(
                    "update hosted_runtime_limit_waits set claimed_until = null
                     where project_id = any($1)",
                    &[&fixture.waiting_project_ids],
                )
                .await?;
            let barrier = Arc::new(tokio::sync::Barrier::new(REPLICAS));
            let mut tasks = Vec::new();
            for replica in &replicas {
                let replica = replica.clone();
                let barrier = barrier.clone();
                tasks.push(crate::tests::spawn_aborting(async move {
                    barrier.wait().await;
                    claim_due_waits(&replica, &policy(), 8, &[], &[]).await
                }));
            }
            let mut all = Vec::new();
            for task in tasks {
                all.extend(task.await??.into_iter().map(|claim| claim.project_id));
            }
            let unique: std::collections::BTreeSet<Uuid> = all.iter().copied().collect();
            assert_eq!(
                unique.len(),
                all.len(),
                "round {round}: a space was claimed by two replicas: {all:?}"
            );
            assert_eq!(
                unique, expected,
                "round {round}: every due space is claimed once"
            );
        }
        Ok(())
    })
    .await
}

/// The give-up and a launch can race: a machine for the space lands after the
/// sweep claimed it for the give-up. Work that machine now runs is not failed.
#[tokio::test]
async fn a_give_up_leaves_work_a_launch_just_took_over() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-give-up-race", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        let job_id = fixture.queue_job(waiting).await?;
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "update agent_jobs set created_at = now() - interval '31 minutes' where id = $1",
                &[&job_id],
            )
            .await?;
        connection
            .execute(
                "update hosted_runtime_limit_waits
                 set first_refused_at = now() - interval '31 minutes'
                 where project_id = $1",
                &[&waiting],
            )
            .await?;
        drop(connection);

        let claim = claim_due_waits(&fixture.state, &policy(), 1, &[], &[])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("the overdue space should be claimed"))?;

        // The user's own ensure got a machine for the space in the meantime.
        let runtime_id = hosted_runtime_id(&fixture.pool, waiting).await?;
        let lease_id = Uuid::new_v4();
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "insert into runtime_leases (id, project_id, runtime_id, status)
                 values ($1, $2, $3, 'launching')",
                &[&lease_id, &waiting, &runtime_id],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&runtime_id, &lease_id],
            )
            .await?;
        drop(connection);

        let mut report = LimitWaitSweepReport::default();
        process_claimed_wait(&fixture.state, &policy(), claim, &mut report).await?;
        assert_eq!(
            (report.expired_jobs, report.attempted, report.finished_waits),
            (0, 0, 1),
            "{report:?}"
        );
        assert_eq!(fixture.job_state(job_id).await?.0, "queued");
        assert!(fixture.wait_row(waiting).await?.is_none());
        Ok(())
    })
    .await
}

/// A tick that gives up on a space's only job must not then launch a machine
/// for it, even when a retry was due: with nothing left to run, a launch (and
/// the reclaim of someone else's idle machine it would bring) is waste.
#[tokio::test]
async fn a_give_up_and_a_due_retry_in_one_tick_launch_nothing() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-give-up-and-retry", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        let job_id = fixture.queue_job(waiting).await?;
        // The blocker's owner has walked away since, so any ensure now would
        // reclaim it.
        fixture.set_blocker_idle_for(3_600).await?;
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "update agent_jobs set created_at = now() - interval '31 minutes' where id = $1",
                &[&job_id],
            )
            .await?;
        connection
            .execute(
                "update hosted_runtime_limit_waits
                 set first_refused_at = now() - interval '31 minutes'
                 where project_id = $1",
                &[&waiting],
            )
            .await?;
        drop(connection);
        fixture.make_due(waiting).await?;

        let report = sweep_hosted_runtime_limit_waits(&fixture.state, &policy()).await?;
        assert_eq!(
            (report.claimed, report.expired_jobs, report.attempted),
            (1, 1, 0),
            "{report:?}"
        );
        assert_eq!(fixture.job_state(job_id).await?.0, "failed");
        assert_eq!(fixture.blocker_status().await?, "ready");
        assert!(fixture.provider_events().await.is_empty());
        assert!(!fixture.has_launched_runtime(waiting).await?);
        Ok(())
    })
    .await
}

/// The studio's own ensure, over HTTP with a user session, is recorded as the
/// user's request, so a later server-initiated refusal never replaces it.
#[tokio::test]
async fn a_user_session_ensure_over_http_records_the_users_request() -> anyhow::Result<()> {
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use futures_util::FutureExt;
    use tower::ServiceExt;

    let fixture = setup("limit-wait-http-user", 1, 10).await?;
    let user_id = Uuid::new_v4();
    crate::tests::ensure_test_user(&fixture.pool, &user_id).await?;
    let body = crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture
            .pool
            .get()
            .await?
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&fixture.org_id, &user_id],
            )
            .await?;
        let token = crate::auth::issue_controller_token(&fixture.state.config, &user_id)
            .map_err(|(status, Json(error))| anyhow::anyhow!("{status}: {}", error.message))?
            .token;
        let app = crate::runtime::router().with_state(fixture.state.clone());
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/ensure")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "project_id": waiting.to_string(),
                            "provider": PROVIDER_ID,
                            "displayName": HOSTED_DISPLAY_NAME,
                            "metadata": { "source": "studio", "sizeId": "boost" },
                            "scope": "exclusive",
                            "originMode": "hosted",
                            "originProtocols": ["http"],
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        let status = response.status();
        let body: JsonValue =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        assert_eq!(status, StatusCode::PAYMENT_REQUIRED, "{body}");
        assert_eq!(body["code"], json!(RUNTIME_LIMIT_REACHED_CODE), "{body}");

        let wait = fixture
            .wait_row(waiting)
            .await?
            .ok_or_else(|| anyhow::anyhow!("the refusal should have recorded a wait"))?;
        assert_eq!(wait.request_source, "user");
        assert_eq!(wait.ensure_request["metadata"]["sizeId"], json!("boost"));
        Ok(())
    });
    let outcome = std::panic::AssertUnwindSafe(body).catch_unwind().await;
    let cleanup = async {
        fixture
            .pool
            .get()
            .await?
            .execute("delete from auth.users where id = $1", &[&user_id])
            .await?;
        anyhow::Ok(())
    }
    .await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// Spaces holding a job past the give-up window are claimed before plain
/// retries, and within a tick an organization that was just served goes after
/// the others, however early its next space is due.
#[tokio::test]
async fn give_ups_come_first_and_organizations_take_turns() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-fairness", 3, 10).await?;
    let other_org = Uuid::new_v4();
    let other_space = Uuid::new_v4();
    let mut cleanup = fixture.shared_db_fixture();
    cleanup.organizations.push(other_org);
    cleanup.projects.push(other_space);
    crate::tests::with_shared_db_fixture(cleanup, async {
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, 'Limit wait other')",
                &[&other_org, &format!("limit-wait-other-{other_org}")],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, project_type, status)
                 values ($1, $2, 'customer', 'active')",
                &[&other_space, &other_org],
            )
            .await?;
        drop(connection);
        let [early, later, overdue] = [
            fixture.waiting_project_ids[0],
            fixture.waiting_project_ids[1],
            fixture.waiting_project_ids[2],
        ];
        for project_id in [early, later, overdue] {
            fixture.refuse(project_id).await?;
        }
        let overdue_job = fixture.queue_job(overdue).await?;
        for project_id in [early, later, other_space] {
            fixture.queue_job(project_id).await?;
        }
        let connection = fixture.pool.get().await?;
        connection
            .execute(
                "insert into hosted_runtime_limit_waits
                    (project_id, ensure_request, first_refused_at, last_refused_at,
                     next_attempt_at, last_error_code)
                 values ($1, '{}'::jsonb, now(), now(), now() - interval '1 minute',
                         'runtime_limit_reached')",
                &[&other_space],
            )
            .await?;
        // `early` and `later` are due long before the other organization's
        // space; `overdue` is not due for a retry at all, but its job has
        // waited out the window.
        connection
            .execute(
                "update hosted_runtime_limit_waits
                 set next_attempt_at = now() - interval '10 minutes'
                 where project_id = any($1)",
                &[&vec![early, later]],
            )
            .await?;
        connection
            .execute(
                "update agent_jobs set created_at = now() - interval '31 minutes' where id = $1",
                &[&overdue_job],
            )
            .await?;
        connection
            .execute(
                "update hosted_runtime_limit_waits
                 set first_refused_at = now() - interval '31 minutes',
                     next_attempt_at = now() + interval '1 hour'
                 where project_id = $1",
                &[&overdue],
            )
            .await?;
        drop(connection);

        let order = [
            claim_due_waits(&fixture.state, &policy(), 1, &[], &[]).await?,
            claim_due_waits(&fixture.state, &policy(), 1, &[overdue], &[fixture.org_id]).await?,
        ];
        let order: Vec<Uuid> = order
            .iter()
            .map(|claims| claims.first().map(|claim| claim.project_id))
            .collect::<Option<_>>()
            .ok_or_else(|| anyhow::anyhow!("every pick should claim a space"))?;
        assert_eq!(
            order,
            vec![overdue, other_space],
            "the give-up first, then the organization not yet served"
        );
        Ok(())
    })
    .await
}

/// A controller whose claim lapsed mid-attempt cannot release, back off or
/// finish the claim another controller has taken since.
#[tokio::test]
async fn a_lapsed_claim_cannot_touch_the_claim_that_replaced_it() -> anyhow::Result<()> {
    let fixture = setup("limit-wait-claim-token", 1, 10).await?;
    crate::tests::with_shared_db_fixture(fixture.shared_db_fixture(), async {
        let waiting = fixture.waiting();
        fixture.refuse(waiting).await?;
        fixture.queue_job(waiting).await?;
        fixture.make_due(waiting).await?;

        let mut lapsed = claim_due_waits(&fixture.state, &policy(), 1, &[], &[])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("the due space should be claimed"))?;
        fixture
            .pool
            .get()
            .await?
            .execute(
                "update hosted_runtime_limit_waits
                 set claimed_until = claimed_until - interval '1 hour'
                 where project_id = $1",
                &[&waiting],
            )
            .await?;
        let lapsed_token: DateTime<Utc> = fixture
            .pool
            .get()
            .await?
            .query_one(
                "select claimed_until from hosted_runtime_limit_waits where project_id = $1",
                &[&waiting],
            )
            .await?
            .get("claimed_until");
        let current = claim_due_waits(&fixture.state, &policy(), 1, &[], &[])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("a lapsed claim is claimable again"))?;
        assert!(current.claim_token > lapsed_token);

        // The lapsed controller's retry now finishes: refused on the limit
        // (the blocker is busy), it backs off. Moving the row's lease back an
        // hour stood in for an hour passing, so its token is the moved one.
        // The backoff must leave the current claim's row alone.
        lapsed.claim_token = lapsed_token;
        let mut report = LimitWaitSweepReport::default();
        process_claimed_wait(&fixture.state, &policy(), lapsed, &mut report).await?;
        assert_eq!((report.attempted, report.launched), (1, 0), "{report:?}");
        assert!(fixture.provider_events().await.is_empty());
        let wait = fixture
            .wait_row(waiting)
            .await?
            .ok_or_else(|| anyhow::anyhow!("a lapsed claim's backoff dropped the wait"))?;
        assert_eq!(
            wait.attempts, 0,
            "a lapsed claim backed off the current one: {wait:?}"
        );
        assert!(
            wait.next_attempt_in <= 0.0,
            "a lapsed claim moved the current claim's next attempt: {wait:?}"
        );
        let claimed_until: Option<DateTime<Utc>> = fixture
            .pool
            .get()
            .await?
            .query_one(
                "select claimed_until from hosted_runtime_limit_waits where project_id = $1",
                &[&waiting],
            )
            .await?
            .get("claimed_until");
        assert_eq!(
            claimed_until,
            Some(current.claim_token),
            "a lapsed claim's backoff cleared the current claim"
        );

        release_claim(&fixture.state, waiting, lapsed_token).await?;
        finish_wait(&fixture.state, waiting, lapsed_token).await?;
        let wait = fixture
            .wait_row(waiting)
            .await?
            .ok_or_else(|| anyhow::anyhow!("a lapsed claim finished the current one"))?;
        assert!(wait.claimed, "a lapsed claim released the current one");

        release_claim(&fixture.state, waiting, current.claim_token).await?;
        assert!(!fixture.wait_row(waiting).await?.expect("kept").claimed);
        Ok(())
    })
    .await
}
