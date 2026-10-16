//! The idle sweep tick on the migrated database: how many pool checkouts a
//! tick with nothing to do takes, how many a project the activity tracker
//! holds adds, and that a tick on a pool of one still acts on every step that
//! finds work, so no step holds the tick's connection while its action waits
//! for another.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use axum::Json;
use bb8_postgres::PostgresConnectionManager;
use chrono::Utc;
use serde_json::json;
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::config::RuntimeProviderConfig;
use crate::tests::{
    build_app_config, build_test_state, pool_gets, require_origin_test_pool, spawn_aborting,
    test_origin_private_key, test_origin_public_key, with_empty_tables, with_shared_db_fixture,
    SharedDbFixture,
};

/// Long enough for any one checkout on an idle test database, short enough
/// that an action waiting on a connection the tick still holds fails fast.
const POOL_OF_ONE_CHECKOUT_TIMEOUT: Duration = Duration::from_secs(2);

/// A whole tick, every action included, on the pool of one.
const TICK_DEADLINE: Duration = Duration::from_secs(60);

/// A hosted provider id (by its `instafy_cloud_` prefix) that only these
/// tests configure.
const HOSTED_TEST_PROVIDER: &str = "instafy_cloud_sweep_tick_test";

/// A provider that is not hosted, for the launches the two launch-timeout
/// steps stop: the idle hosted stop passes over its runtimes, so only their
/// own step can stop them.
const MACHINE_TEST_PROVIDER: &str = "sweep_tick_test_machines";

/// Every step's candidate query starts from one of these tables, or finds a
/// deleted space only through a row in one, so a tick on empty copies of
/// them has nothing to do.
const SWEEP_TABLES: [&str; 6] = [
    "runtimes",
    "agent_jobs",
    "runtime_tunnel_grants",
    "runs",
    "conversation_send_queue",
    "automations",
];

/// A tick with nothing to do takes one pool checkout for all of its steps,
/// where each step used to take its own.
#[tokio::test]
async fn an_idle_sweep_tick_takes_one_pool_checkout() -> anyhow::Result<()> {
    with_empty_tables(&SWEEP_TABLES, |pool| async move {
        let state = build_test_state(
            pool.clone(),
            build_app_config(
                test_origin_private_key(),
                test_origin_public_key(),
                "idle-sweep-tick-checkouts",
            ),
        );
        for tick in 1..=2 {
            let before = pool_gets(&pool);
            crate::runtime::sweep_idle_activity(&state).await?;
            assert_eq!(
                pool_gets(&pool) - before,
                1,
                "idle tick {tick} takes one checkout"
            );
            let pool_state = pool.state();
            assert_eq!(
                pool_state.idle_connections, pool_state.connections,
                "tick {tick} gave its connection back"
            );
        }
        Ok(())
    })
    .await
}

/// A project the in-memory activity tracker holds comes up for a lease
/// release every idle TTL, and the sweep re-arms it when nothing was
/// released. Its release takes a checkout of its own and the rest of the
/// tick still shares one, so each such project costs one checkout, as it did
/// when every step took its own.
#[tokio::test]
async fn a_sweep_tick_with_a_tracked_project_takes_one_checkout_more() -> anyhow::Result<()> {
    with_empty_tables(&SWEEP_TABLES, |pool| async move {
        let state = build_test_state(
            pool.clone(),
            build_app_config(
                test_origin_private_key(),
                test_origin_public_key(),
                "idle-sweep-tick-tracked-project",
            ),
        );
        let project_id = Uuid::new_v4();
        state
            .runtime_activity
            .mark_active(
                project_id,
                Some(30),
                Some(Utc::now() - chrono::Duration::hours(1)),
            )
            .await;

        let before = pool_gets(&pool);
        crate::runtime::sweep_idle_activity(&state).await?;
        assert_eq!(
            pool_gets(&pool) - before,
            2,
            "the lease release takes one checkout and the rest of the tick one"
        );
        let pool_state = pool.state();
        assert_eq!(
            pool_state.idle_connections, pool_state.connections,
            "the tick gave its connection back"
        );
        assert!(
            state.runtime_activity.idle_candidates().await.is_empty(),
            "the sweep re-armed the project it found nothing to release for"
        );

        let before = pool_gets(&pool);
        crate::runtime::sweep_idle_activity(&state).await?;
        assert_eq!(
            pool_gets(&pool) - before,
            1,
            "a re-armed project costs nothing until its TTL runs out again"
        );
        Ok(())
    })
    .await
}

/// One project per step with work, so no step's candidate is another's.
struct Spaces {
    tracker: Uuid,
    orphan_requested: Uuid,
    stuck_requested: Uuid,
    stale: Uuid,
    idle_hosted: Uuid,
    requeued: Uuid,
    stuck_queued: Uuid,
    terminal: Uuid,
    stranded: Uuid,
    deleted: Uuid,
}

impl Spaces {
    fn new() -> Self {
        Self {
            tracker: Uuid::new_v4(),
            orphan_requested: Uuid::new_v4(),
            stuck_requested: Uuid::new_v4(),
            stale: Uuid::new_v4(),
            idle_hosted: Uuid::new_v4(),
            requeued: Uuid::new_v4(),
            stuck_queued: Uuid::new_v4(),
            terminal: Uuid::new_v4(),
            stranded: Uuid::new_v4(),
            deleted: Uuid::new_v4(),
        }
    }

    fn all(&self) -> Vec<Uuid> {
        vec![
            self.tracker,
            self.orphan_requested,
            self.stuck_requested,
            self.stale,
            self.idle_hosted,
            self.requeued,
            self.stuck_queued,
            self.terminal,
            self.stranded,
            self.deleted,
        ]
    }
}

/// What the tick should find, one row per step with work.
struct Seeded {
    tracker_job: Uuid,
    orphan_requested_runtime: Uuid,
    stuck_requested_runtime: Uuid,
    stale_runtime: Uuid,
    idle_hosted_runtime: Uuid,
    requeued_job: Uuid,
    requeued_run: Uuid,
    stuck_queued_runtime: Uuid,
    terminal_runtime: Uuid,
    stranded_job: Uuid,
    stranded_run: Uuid,
    deleted_runtime: Uuid,
}

async fn insert_runtime(
    client: &tokio_postgres::Client,
    project_id: Uuid,
    provider: &str,
    status: &str,
    idle_ttl_seconds: i32,
    last_seen_age_seconds: Option<i64>,
    age_seconds: i64,
) -> anyhow::Result<Uuid> {
    let runtime_id = Uuid::new_v4();
    client
        .execute(
            "insert into runtimes (
                 id, project_id, provider, status, idle_ttl_seconds, last_seen_at,
                 created_at, updated_at
             ) values (
                 $1, $2, $3, $4, $5, now() - ($6::bigint * interval '1 second'),
                 now() - ($7::bigint * interval '1 second'),
                 now() - ($7::bigint * interval '1 second')
             )",
            &[
                &runtime_id,
                &project_id,
                &provider,
                &status,
                &idle_ttl_seconds,
                &last_seen_age_seconds,
                &age_seconds,
            ],
        )
        .await?;
    Ok(runtime_id)
}

/// Puts `runtime_id` on a new lease of `status`, requested (and, unless it is
/// still launching, launched) `age_seconds` ago.
async fn attach_lease(
    client: &tokio_postgres::Client,
    project_id: Uuid,
    runtime_id: Uuid,
    status: &str,
    age_seconds: i64,
) -> anyhow::Result<()> {
    let lease_id = Uuid::new_v4();
    client
        .execute(
            "insert into runtime_leases (
                 id, project_id, runtime_id, status, requested_at, launched_at
             ) values (
                 $1, $2, $3, $4, now() - ($5::bigint * interval '1 second'),
                 case when $4 = 'launching' then null
                      else now() - ($5::bigint * interval '1 second') end
             )",
            &[&lease_id, &project_id, &runtime_id, &status, &age_seconds],
        )
        .await?;
    client
        .execute(
            "update runtimes set active_lease_id = $2 where id = $1",
            &[&runtime_id, &lease_id],
        )
        .await?;
    Ok(())
}

async fn insert_run(client: &tokio_postgres::Client, project_id: Uuid) -> anyhow::Result<Uuid> {
    let run_id = Uuid::new_v4();
    client
        .execute(
            "insert into runs (id, project_id, run_type, status, progress, progress_stage)
             values ($1, $2, 'prompt', 'queued', 0, 'agent:queued')",
            &[&run_id, &project_id],
        )
        .await?;
    Ok(run_id)
}

#[allow(clippy::too_many_arguments)]
async fn insert_job(
    client: &tokio_postgres::Client,
    project_id: Uuid,
    status: &str,
    intent: &str,
    run_id: Option<Uuid>,
    target_runtime_id: Option<Uuid>,
    payload: serde_json::Value,
    age_seconds: i64,
) -> anyhow::Result<Uuid> {
    let job_id = Uuid::new_v4();
    client
        .execute(
            "insert into agent_jobs (
                 id, project_id, status, intent, run_id, target_runtime_id, payload,
                 created_at
             ) values ($1, $2, $3, $4, $5, $6, $7, now() - ($8::bigint * interval '1 second'))",
            &[
                &job_id,
                &project_id,
                &status,
                &intent,
                &run_id,
                &target_runtime_id,
                &PgJson(payload),
                &age_seconds,
            ],
        )
        .await?;
    Ok(job_id)
}

async fn seed(client: &tokio_postgres::Client, spaces: &Spaces) -> anyhow::Result<Seeded> {
    for project_id in spaces.all() {
        // The deleted space was deleted five minutes ago, past the grace
        // that leaves it to its delete's own stop.
        client
            .execute(
                "insert into projects (id, project_type, status, updated_at)
                 values ($1, 'customer',
                         case when $2 then 'deleted' else 'active' end,
                         case when $2 then now() - interval '5 minutes' else now() end)",
                &[&project_id, &(project_id == spaces.deleted)],
            )
            .await?;
    }

    // In-memory idle candidate: a turn whose job lease ran out.
    let tracker_job = insert_job(
        client,
        spaces.tracker,
        "leased",
        "terminal_command",
        None,
        None,
        json!({}),
        600,
    )
    .await?;
    client
        .execute(
            "update agent_jobs set leased_at = now() - interval '10 minutes',
                                   lease_expires_at = now() - interval '1 minute'
             where id = $1",
            &[&tracker_job],
        )
        .await?;

    // A launch request that never got a lease or came up.
    let orphan_requested_runtime = insert_runtime(
        client,
        spaces.orphan_requested,
        MACHINE_TEST_PROVIDER,
        "requested",
        3600,
        None,
        2 * 60 * 60,
    )
    .await?;

    // A launch whose lease never registered within the launch timeout.
    let stuck_requested_runtime = insert_runtime(
        client,
        spaces.stuck_requested,
        MACHINE_TEST_PROVIDER,
        "requested",
        3600,
        None,
        2 * 60 * 60,
    )
    .await?;
    attach_lease(
        client,
        spaces.stuck_requested,
        stuck_requested_runtime,
        "launching",
        2 * 60 * 60,
    )
    .await?;

    // A runtime whose heartbeat stopped an hour ago.
    let stale_runtime = insert_runtime(
        client,
        spaces.stale,
        "self-hosted",
        "ready",
        60,
        Some(60 * 60),
        2 * 60 * 60,
    )
    .await?;

    // A healthy hosted runtime nobody has used since it launched two hours
    // ago.
    let idle_hosted_runtime = insert_runtime(
        client,
        spaces.idle_hosted,
        HOSTED_TEST_PROVIDER,
        "ready",
        600,
        Some(5),
        2 * 60 * 60,
    )
    .await?;
    attach_lease(
        client,
        spaces.idle_hosted,
        idle_hosted_runtime,
        "active",
        2 * 60 * 60,
    )
    .await?;

    // A job a stop requeued an hour ago, in a space with no runtime left.
    let requeued_run = insert_run(client, spaces.requeued).await?;
    let requeued_job = insert_job(
        client,
        spaces.requeued,
        "queued",
        "feature",
        Some(requeued_run),
        None,
        json!({
            "requeuedAt": (Utc::now() - chrono::Duration::hours(1)).to_rfc3339(),
            "requeuedReason": "heartbeat_timeout",
        }),
        2 * 60 * 60,
    )
    .await?;

    // A hosted runtime that went quiet with a job queued for it.
    let stuck_queued_runtime = insert_runtime(
        client,
        spaces.stuck_queued,
        HOSTED_TEST_PROVIDER,
        "ready",
        600,
        Some(2 * 60),
        60,
    )
    .await?;
    attach_lease(
        client,
        spaces.stuck_queued,
        stuck_queued_runtime,
        "active",
        60,
    )
    .await?;
    insert_job(
        client,
        spaces.stuck_queued,
        "queued",
        "terminal_command",
        None,
        Some(stuck_queued_runtime),
        json!({}),
        5 * 60,
    )
    .await?;

    // A runtime record that has been offline for 25 minutes.
    let terminal_runtime = insert_runtime(
        client,
        spaces.terminal,
        "self-hosted",
        "offline",
        600,
        Some(2 * 60 * 60),
        25 * 60,
    )
    .await?;

    // A platform AI job pinned to a stopped self-hosted machine.
    let stranded_runtime = insert_runtime(
        client,
        spaces.stranded,
        "self-hosted",
        "stopped",
        600,
        None,
        0,
    )
    .await?;
    let stranded_run = insert_run(client, spaces.stranded).await?;
    let stranded_job = insert_job(
        client,
        spaces.stranded,
        "queued",
        "feature",
        Some(stranded_run),
        Some(stranded_runtime),
        json!({}),
        crate::runtime::STRANDED_PLATFORM_JOB_GRACE_SECONDS + 60,
    )
    .await?;

    // A hosted runtime still up in a space deleted five minutes ago.
    let deleted_runtime = insert_runtime(
        client,
        spaces.deleted,
        HOSTED_TEST_PROVIDER,
        "ready",
        600,
        Some(5),
        2 * 60 * 60,
    )
    .await?;
    attach_lease(
        client,
        spaces.deleted,
        deleted_runtime,
        "active",
        2 * 60 * 60,
    )
    .await?;

    Ok(Seeded {
        tracker_job,
        orphan_requested_runtime,
        stuck_requested_runtime,
        stale_runtime,
        idle_hosted_runtime,
        requeued_job,
        requeued_run,
        stuck_queued_runtime,
        terminal_runtime,
        stranded_job,
        stranded_run,
        deleted_runtime,
    })
}

async fn runtime_status(
    client: &tokio_postgres::Client,
    runtime_id: Uuid,
) -> anyhow::Result<String> {
    Ok(client
        .query_one("select status from runtimes where id = $1", &[&runtime_id])
        .await?
        .get("status"))
}

async fn job_status(
    client: &tokio_postgres::Client,
    job_id: Uuid,
) -> anyhow::Result<(String, Option<String>)> {
    let row = client
        .query_one(
            "select status, outcome from agent_jobs where id = $1",
            &[&job_id],
        )
        .await?;
    Ok((row.get("status"), row.get("outcome")))
}

/// A tick on a pool of one acts on every step that has work: the tick's
/// connection is back in the pool before each action takes its own. Were it
/// held, each action would wait out the checkout timeout and fail: the stops
/// and the lease release would not happen, and a failed run would be
/// published without the run it read.
#[tokio::test]
async fn a_sweep_tick_on_a_pool_of_one_acts_on_every_step_with_work() -> anyhow::Result<()> {
    let setup = require_origin_test_pool("a_sweep_tick_on_a_pool_of_one_acts").await?;
    let spaces = Spaces::new();
    let fixture = SharedDbFixture {
        projects: spaces.all(),
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        // The runtime of each release, so the assertions below count only
        // this test's own: a step may also release what an earlier, aborted
        // run left in a long-lived test database.
        let released: Arc<Mutex<Vec<Option<Uuid>>>> = Arc::default();
        let provider_app = axum::Router::new()
            .route(
                "/runtime/release",
                axum::routing::post({
                    let released = released.clone();
                    move |body: axum::body::Bytes| {
                        let released = released.clone();
                        async move {
                            let runtime_id = serde_json::from_slice::<serde_json::Value>(&body)
                                .ok()
                                .and_then(|body| {
                                    body["runtime_id"]
                                        .as_str()
                                        .and_then(|value| Uuid::parse_str(value).ok())
                                });
                            released.lock().unwrap().push(runtime_id);
                            StatusCode::NO_CONTENT
                        }
                    }
                }),
            )
            .route(
                "/runtime/inspect",
                axum::routing::post(|| async { Json(json!({ "oom_killed": false })) }),
            );
        let provider_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let provider_address = provider_listener.local_addr()?;
        let _provider = spawn_aborting(async move {
            axum::serve(provider_listener, provider_app)
                .await
                .expect("serve sweep tick test provider");
        });

        let seeded = seed(&*setup.get().await?, &spaces).await?;

        let manager = PostgresConnectionManager::new_from_stringlike(
            std::env::var("TEST_DATABASE_URL")?,
            crate::config::database_tls(),
        )?;
        let pool = bb8::Pool::builder()
            .max_size(1)
            .connection_timeout(POOL_OF_ONE_CHECKOUT_TIMEOUT)
            .build(manager)
            .await?;
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "sweep-tick-pool-of-one",
        );
        for provider_id in [HOSTED_TEST_PROVIDER, MACHINE_TEST_PROVIDER] {
            config.runtime_providers.push(RuntimeProviderConfig {
                id: provider_id.to_string(),
                display_name: "Sweep tick test".to_string(),
                kind: "test".to_string(),
                owner_org_id: None,
                allowed_org_ids: vec![],
                endpoint: Some(format!("http://{provider_address}")),
                auth_token: None,
                metadata: None,
            });
        }
        let state = build_test_state(pool.clone(), config);
        state
            .runtime_activity
            .mark_active(
                spaces.tracker,
                Some(60),
                Some(Utc::now() - chrono::Duration::hours(1)),
            )
            .await;
        let mut events = state.events.subscribe();

        tokio::time::timeout(TICK_DEADLINE, crate::runtime::sweep_idle_activity(&state))
            .await
            .expect("the sweep tick finished")?;

        let client = setup.get().await?;
        let (status, _) = job_status(&client, seeded.tracker_job).await?;
        assert_eq!(
            status, "queued",
            "the idle release requeued the expired lease"
        );
        for (step, runtime_id, expected) in [
            ("orphan launch", seeded.orphan_requested_runtime, "stopped"),
            ("launch timeout", seeded.stuck_requested_runtime, "stopped"),
            ("heartbeat timeout", seeded.stale_runtime, "stopped"),
            ("idle hosted stop", seeded.idle_hosted_runtime, "stopped"),
            (
                "queued stall recovery",
                seeded.stuck_queued_runtime,
                "stopped",
            ),
            ("terminal cleanup", seeded.terminal_runtime, "removed"),
            ("deleted space stop", seeded.deleted_runtime, "stopped"),
        ] {
            assert_eq!(
                runtime_status(&client, runtime_id).await?,
                expected,
                "{step} did not act"
            );
        }
        let deleted_stop_reason: Option<String> = client
            .query_one(
                "select data ->> 'reason' from runtime_events
                 where runtime_id = $1 and kind = 'stopped'",
                &[&seeded.deleted_runtime],
            )
            .await?
            .get(0);
        assert_eq!(
            deleted_stop_reason.as_deref(),
            Some("space_deleted"),
            "another step took the deleted space's runtime"
        );
        let deleted_releases = released
            .lock()
            .unwrap()
            .iter()
            .filter(|runtime_id| **runtime_id == Some(seeded.deleted_runtime))
            .count();
        assert_eq!(
            deleted_releases, 1,
            "the deleted space's machine was released once"
        );
        assert_eq!(
            job_status(&client, seeded.requeued_job).await?,
            ("failed".to_string(), Some("expired".to_string())),
            "the requeued job expiry did not act"
        );
        assert_eq!(
            job_status(&client, seeded.stranded_job).await?,
            ("failed".to_string(), Some("failed".to_string())),
            "the stranded platform job did not fail"
        );

        // Each failed run is published with the run it read on a connection
        // of its own.
        let mut published = HashMap::new();
        while let Ok(event) = events.try_recv() {
            if event.kind == "run.completed" {
                if let Some(run_id) = event.run_id {
                    published.insert(run_id, event.data["run"]["id"].clone());
                }
            }
        }
        for run_id in [seeded.requeued_run, seeded.stranded_run] {
            assert_eq!(
                published.get(&run_id),
                Some(&json!(run_id)),
                "run {run_id} was published without its snapshot: {published:?}"
            );
        }
        Ok(())
    })
    .await
}
